// File compare, as in PyCharm: Compare Files (two files selected in the Project tool window, Ctrl+D there), Compare
// With… (the current or selected file against a file you pick), Compare with Clipboard (editor context menu, View menu)
// and Compare with Branch… (Git: a branch or revision's version of the file). Each opens a diff tab: Monaco's diff
// editor with PyCharm's blue changed blocks, F7 / Shift+F7 (Next / Previous Difference, also in the vcs plugin's diff
// tabs), and a Side-by-side / Unified switch. The right side is the file's own document when it is a file: editing it
// edits the file, the tab shows the modified mark, Save All writes it and closing the tab asks first. The left side is
// a read-only snapshot. Binary files and files over 5 MB get a message instead (and whether the bytes are the same).
(() => {
  const { el, basename, samePath } = ide.util;
  const rel = (p) => ide.util.rel(p);
  const MAX_DIFF_BYTES = 5 * 1024 * 1024;
  const views = new Map(); // tab -> view
  let seq = 0;

  const userText = (tag, cls, text) => { const n = el(tag, cls, text); n.dataset.userText = ''; return n; };
  // A title is UI text, or {user} for user data (paths, branch names, hashes).
  const titleNode = (t, cls) => (typeof t === 'string' ? el('span', cls, t) : userText('span', cls, t.user));
  const titleText = (t) => (typeof t === 'string' ? t : t.user);
  const sizeText = (n) => (n < 1024 ? tr('{n} bytes', { n }) : n < 1048576 ? `${(n / 1024).toFixed(1)} KB` : `${(n / 1048576).toFixed(1)} MB`);
  const languageOf = (path) => {
    const name = basename(path).toLowerCase();
    return ide.monaco.languages.getLanguages().find((l) => l.filenames?.some((f) => f.toLowerCase() === name) || l.extensions?.some((e) => name.endsWith(e.toLowerCase())))?.id || 'plaintext';
  };

  // ---------- reading the sides ----------
  // -> {text} | {binary, size} | {tooLarge, size} | {error}. An open document's text wins over the disk.
  async function readSide(path) {
    const doc = ide.getDocument(path);
    if (doc && !doc.model.isDisposed()) {
      const text = doc.model.getValue();
      return text.length > MAX_DIFF_BYTES ? { tooLarge: true, size: text.length } : { text };
    }
    try {
      const r = await ide.api.invoke('fs:readText', path);
      if (r.binary) return { binary: true, size: r.size };
      if (r.tooLarge || r.size > MAX_DIFF_BYTES) return { tooLarge: true, size: r.size };
      return { text: r.text };
    } catch (e) {
      return { error: ide.util.errorText(e) };
    }
  }
  // The editable side: the file's document (already open, or loaded for the diff tab).
  async function documentOf(path) {
    const open = ide.getDocument(path);
    if (open) return open;
    try { return await ide.loadDocument(path); } catch (e) { return { error: ide.util.errorText(e) }; }
  }

  // ---------- diff view ----------
  const changesOf = (diff) => diff.getLineChanges() || [];
  const startOf = (c, original) => Math.max(1, original ? c.originalStartLineNumber : c.modifiedStartLineNumber);
  const unifiedDiffs = new WeakSet(); // diff editors shown as one unified pane
  const sideBySide = (diff) => !unifiedDiffs.has(diff);
  // Next (dir 1) or previous (-1) difference from the caret, in the side that has the keyboard (the right one unless the
  // left has it). -> false at the first or last difference.
  function go(diff, dir) {
    const list = changesOf(diff);
    const orig = diff.getOriginalEditor();
    const onOriginal = sideBySide(diff) && orig.hasTextFocus();
    const ed = onOriginal ? orig : diff.getModifiedEditor();
    const line = ed.getPosition()?.lineNumber || 1;
    const target = dir > 0 ? list.find((c) => startOf(c, onOriginal) > line) : [...list].reverse().find((c) => startOf(c, onOriginal) < line);
    if (!target) return false;
    reveal(diff, target, onOriginal);
    return true;
  }
  function reveal(diff, change, onOriginal = false, focus = true) {
    const ed = onOriginal ? diff.getOriginalEditor() : diff.getModifiedEditor();
    const lineNumber = startOf(change, onOriginal);
    ed.setPosition({ lineNumber, column: 1 });
    ed.revealLineInCenter(lineNumber);
    if (focus) ed.focus();
  }

  // PyCharm colors a changed block blue on both sides (Monaco only knows inserted and removed).
  function markModified(diff, marks) {
    const { Range } = ide.monaco;
    const orig = [];
    const mod = [];
    for (const c of changesOf(diff)) {
      if (!c.originalEndLineNumber || !c.modifiedEndLineNumber) continue;
      orig.push({ range: new Range(c.originalStartLineNumber, 1, c.originalEndLineNumber, 1), options: { isWholeLine: true, className: 'cmp-mod', marginClassName: 'cmp-mod' } });
      mod.push({ range: new Range(c.modifiedStartLineNumber, 1, c.modifiedEndLineNumber, 1), options: { isWholeLine: true, className: 'cmp-mod', marginClassName: 'cmp-mod' } });
      for (const ch of c.charChanges || []) {
        if (ch.originalEndLineNumber) orig.push({ range: new Range(ch.originalStartLineNumber, ch.originalStartColumn, ch.originalEndLineNumber, ch.originalEndColumn), options: { className: 'cmp-mod-char' } });
        if (ch.modifiedEndLineNumber) mod.push({ range: new Range(ch.modifiedStartLineNumber, ch.modifiedStartColumn, ch.modifiedEndLineNumber, ch.modifiedEndColumn), options: { className: 'cmp-mod-char' } });
      }
    }
    marks.orig.set(orig);
    marks.mod.set(mod);
  }

  function toolButton(cls, icon, title, actionId, run) {
    const b = el('button', `cmp-tool ${cls}`, icon);
    ide.keymap.tooltip(b, title, actionId);
    b.onclick = run;
    return b;
  }

  const differOnlyInSeparators = (a, b) => a !== b && a.replace(/\r\n?/g, '\n') === b.replace(/\r\n?/g, '\n');

  // left: {title, text}; right: {title, doc} (editable) or {title, text} (read-only). separators: the texts' line
  // separators count, which Monaco's models normalize away.
  function mountView(host, { left, right, language, separators }) {
    host.classList.add('cmp-view');
    const bar = el('div', 'cmp-bar');
    const count = el('span', 'cmp-count');
    const mode = el('select', 'cmp-mode');
    mode.add(new Option(tr('Side-by-side viewer'), 'side'));
    mode.add(new Option(tr('Unified viewer'), 'unified'));
    mode.title = tr('Viewer');
    const unified = () => mode.value === 'unified';
    mode.value = ide.settings.get('diff.unified', false) ? 'unified' : 'side';
    const head = el('div', 'cmp-head');
    const leftTitle = titleNode(left.title, 'cmp-side cmp-left-title');
    const rightTitle = titleNode(right.title, 'cmp-side cmp-right-title');
    const readOnly = !right.doc;
    head.append(leftTitle, rightTitle);
    if (readOnly) rightTitle.append(el('span', 'cmp-ro', ` — ${tr('read-only')}`));
    const box = el('div', 'cmp-body');
    let diff = null;
    bar.append(
      toolButton('cmp-prev', '↑', tr('Previous Difference'), 'PreviousDiff', () => diff && go(diff, -1)),
      toolButton('cmp-next', '↓', tr('Next Difference'), 'NextDiff', () => diff && go(diff, 1)),
      count, el('span', 'cmp-spacer'), mode,
    );
    host.append(bar, head, box);

    const monaco = ide.monaco;
    const original = monaco.editor.createModel(left.text ?? '', language);
    const modified = right.doc ? right.doc.model : monaco.editor.createModel(right.text ?? '', language);
    diff = monaco.editor.createDiffEditor(box, {
      ...ide.editorOptions(), automaticLayout: true, renderSideBySide: !unified(), useInlineViewWhenSpaceIsLimited: false,
      originalEditable: false, readOnly, ignoreTrimWhitespace: false, renderMarginRevertIcon: false, renderOverviewRuler: true,
      minimap: { enabled: false }, scrollBeyondLastLine: false, glyphMargin: false,
    });
    diff.setModel({ original, modified });
    const marks = { orig: diff.getOriginalEditor().createDecorationsCollection(), mod: diff.getModifiedEditor().createDecorationsCollection() };
    let computed = false;
    const onlySeparators = separators && differOnlyInSeparators(left.text, right.text);
    const update = () => {
      const n = changesOf(diff).length;
      count.textContent = !computed ? tr('Comparing…') : n ? (n === 1 ? tr('1 difference') : tr('{n} differences', { n }))
        : onlySeparators ? tr('Contents have differences only in line separators') : tr('Contents are identical');
      host.dataset.differences = computed ? String(n) : '';
    };
    update();
    diff.onDidUpdateDiff(() => {
      const first = !computed;
      computed = true;
      markModified(diff, marks);
      update();
      // As PyCharm, the view opens at the first difference with the keyboard in it (F7 goes on from there).
      if (!first) return;
      const c = changesOf(diff)[0];
      const shown = host.isConnected && !host.classList.contains('hidden');
      if (c) reveal(diff, c, false, shown);
      else if (shown) diff.getModifiedEditor().focus();
    });
    const applyMode = () => {
      diff.updateOptions({ renderSideBySide: !unified() });
      if (unified()) unifiedDiffs.add(diff); else unifiedDiffs.delete(diff);
      host.classList.toggle('cmp-unified', unified());
    };
    mode.onchange = () => { ide.settings.set('diff.unified', unified()); applyMode(); };
    applyMode();
    return {
      diff,
      host,
      go: (dir) => go(diff, dir),
      count: () => changesOf(diff).length,
      ready: () => computed,
      setUnified(on) { mode.value = on ? 'unified' : 'side'; mode.onchange(); },
      dispose() {
        // The right side may be the file's document, which outlives this view.
        marks.orig.clear();
        marks.mod.clear();
        diff.dispose();
        // Monaco keeps a global hover-delegate factory bound to the last editor's (scoped) services; once a diff editor's
        // scope is disposed every context menu throws. A throwaway editor rebinds it (as the vcs plugin does).
        monaco.editor.create(el('div')).dispose();
        original.dispose();
        if (!right.doc) modified.dispose();
      },
    };
  }

  // A diff tab. The tab holds the right side's document (core editors.js: ide.openCustomTab({doc})).
  function openDiffTab({ id, title, left, right, language, separators }) {
    if (ide.findTab(id)) {
      // The same comparison opened while this one was reading the files: a document loaded for it is not needed.
      if (right.doc) ide.releaseDocument(right.doc);
      return ide.openCustomTab({ id });
    }
    return ide.openCustomTab({
      id, title, icon: '⇆', doc: right.doc,
      mount(host, tab) {
        host.classList.add('cmp-tab');
        const view = mountView(host, { left, right, language, separators });
        views.set(tab, view);
        tab.dispose = () => { views.delete(tab); view.dispose(); };
      },
    });
  }

  // Two texts, both read-only (the tests plugin's Comparison Failure). left, right: {title, text}. The same id opened
  // again shows the new texts in a fresh tab: a test run again may fail with other values.
  function compareTexts({ id, title, left, right, language = 'plaintext' }) {
    if (ide.findTab(id)) ide.closeTab(id, true);
    return openDiffTab({ id, title, language, left, right, separators: true });
  }

  // Why a side cannot be shown as text (r from readSide, or a document's {binary | tooLarge}), or null.
  const problemOf = (name, r) => (r.error !== undefined ? tr('Cannot read {name}: {error}', { name, error: r.error })
    : r.binary ? tr('{name} is a binary file ({size}).', { name, size: sizeText(r.size) })
      : r.tooLarge ? tr('{name} is too large to compare as text ({size}; the limit is {limit}).', { name, size: sizeText(r.size), limit: sizeText(MAX_DIFF_BYTES) })
        : null);
  // A tab that says why the sides are not shown as a diff; with `bytes` ([a, b], two files) also whether they are equal.
  async function openMessageTab({ id, title, notes, paths, bytes }) {
    let verdict = null;
    if (bytes) { try { verdict = await ide.api.invoke('compare:sameBytes', bytes[0], bytes[1]); } catch {} }
    if (ide.findTab(id)) ide.closeTab(id, true);
    return ide.openCustomTab({
      id, title, icon: '⇆',
      mount(host) {
        host.classList.add('cmp-tab', 'cmp-message');
        const box = el('div', 'cmp-message-box');
        box.append(el('div', 'cmp-message-title', tr('The contents cannot be compared as text.')));
        for (const l of notes.filter(Boolean)) box.append(el('div', 'cmp-message-line', l));
        if (verdict) box.append(el('div', 'cmp-message-verdict', verdict.same ? tr('The files are identical.') : tr('The files differ.')));
        const list = el('div', 'cmp-message-paths');
        for (const p of paths) list.append(userText('div', null, p));
        box.append(list);
        host.append(box);
        host.dataset.verdict = verdict ? (verdict.same ? 'same' : 'different') : '';
      },
    });
  }

  // ---------- what is compared ----------
  // left: a read-only snapshot of `a`; right: `b`'s document, editable.
  async function compareFiles(a, b) {
    if (!a || !b || samePath(a, b)) return null;
    const id = `${b} [${tr('compared with {name}', { name: rel(a) })}]`;
    const title = tr('{left} vs {right}', { left: basename(a), right: basename(b) });
    if (ide.findTab(id)) return ide.openCustomTab({ id });
    const [ra, rb] = await Promise.all([readSide(a), readSide(b)]);
    const unreadable = ra.error !== undefined || rb.error !== undefined;
    if (ra.text === undefined || rb.text === undefined) {
      return openMessageTab({ id, title, notes: [problemOf(basename(a), ra), problemOf(basename(b), rb)], paths: [a, b], bytes: unreadable ? null : [a, b] });
    }
    const doc = await documentOf(b);
    if (!doc || doc.unsupported || doc.error !== undefined) {
      return openMessageTab({ id, title, notes: [problemOf(basename(b), doc?.unsupported || { error: doc?.error || '' })], paths: [a, b], bytes: doc?.unsupported ? [a, b] : null });
    }
    return openDiffTab({ id, title, language: doc.model.getLanguageId(), left: { title: { user: rel(a) }, text: ra.text }, right: { title: { user: rel(b) }, doc } });
  }

  const BROWSE = { browse: true };
  async function pickFile(except) {
    let files = [];
    try { files = ide.root ? await ide.api.walk(ide.root) : []; } catch {}
    const items = [
      { label: tr('Browse…'), detail: tr('Choose a file outside the project'), value: BROWSE },
      ...files.filter((f) => !samePath(f, except)).slice(0, 20000).map((f) => ({ label: basename(f), detail: rel(f), value: f, icon: ide.fileIcon(f) })),
    ];
    const v = await ide.ui.pick({ placeholder: tr('File to compare {name} with', { name: basename(except) }), items });
    if (v === BROWSE) return ide.api.openFileDialog();
    return typeof v === 'string' ? v : null;
  }
  async function compareWith(path) {
    if (!path) return null;
    const other = await pickFile(path);
    return other ? compareFiles(other, path) : null;
  }

  const docOfEditor = (ed) => {
    const model = ed?.getModel();
    return (model && ide.tabs.find((t) => t.doc?.model === model)?.doc) || null;
  };
  // Clipboard on the left; the selection (read-only) or the whole file (editable) on the right.
  async function compareWithClipboard(ed = ide.editor) {
    const doc = docOfEditor(ed) || ide.activeTab()?.doc;
    if (!doc) { ide.ui.alert(tr('Open a file to compare it with the clipboard.')); return null; }
    let clip = '';
    try { clip = (await ide.api.invoke('clipboard:readText')) || ''; } catch {}
    const sel = ed && ed.getModel() === doc.model ? ed.getSelection() : null;
    const name = basename(doc.path);
    const language = doc.model.getLanguageId();
    const n = ++seq;
    if (sel && !sel.isEmpty()) {
      return openDiffTab({ id: `${doc.path} [${tr('Clipboard')} ${n}]`, title: tr('Clipboard vs {name}', { name }), language,
        left: { title: tr('Clipboard'), text: clip }, right: { title: tr('Selection in {name}', { name }), text: doc.model.getValueInRange(sel) } });
    }
    return openDiffTab({ id: `${doc.path} [${tr('Clipboard')} ${n}]`, title: tr('Clipboard vs {name}', { name }), language,
      left: { title: tr('Clipboard'), text: clip }, right: { title: { user: rel(doc.path) }, doc } });
  }

  // ---------- Compare with Branch ----------
  const inRepo = () => !!ide.vcs?.repo?.() && !!ide.root;
  async function pickRevision(path) {
    const [branches, log] = await Promise.all([
      ide.vcs.invoke('branches', ide.root).catch(() => ({ local: [], remote: [] })),
      ide.vcs.invoke('log', ide.root, 50).catch(() => []),
    ]);
    const items = [
      ...(branches?.local || []).map((b) => ({ label: b, detail: tr('Local branch'), value: b, icon: ide.icon?.('branch') })),
      ...(branches?.remote || []).map((b) => ({ label: b, detail: tr('Remote branch'), value: b, icon: ide.icon?.('branch') })),
      ...(log || []).map((c) => ({ label: c.short, detail: c.subject, value: c.hash, icon: ide.icon?.('commit') })),
    ];
    return ide.ui.pick({
      placeholder: tr('Branch or revision to compare {name} with', { name: basename(path) }),
      items: async (q) => {
        const query = q.trim().toLowerCase();
        const shown = items.filter((i) => !query || i.label.toLowerCase().includes(query) || i.detail?.toLowerCase().includes(query));
        // Any revision git understands (a tag, HEAD~2, a hash) can be typed.
        if (query && !items.some((i) => i.label.toLowerCase() === query)) shown.push({ label: q.trim(), detail: tr('Revision'), value: q.trim() });
        return shown;
      },
    });
  }
  async function compareWithBranch(path, ref) {
    if (!inRepo()) { ide.ui.alert(tr('The project is not a Git repository.')); return null; }
    if (!path) { ide.ui.alert(tr('Open or select a file to compare it with a branch.')); return null; }
    ref = ref || await pickRevision(path);
    if (!ref) return null;
    const short = /^[0-9a-f]{40}$/i.test(ref) ? ref.slice(0, 8) : ref;
    let text = null;
    try { text = await ide.vcs.invoke('show', ide.root, path, ref); } catch {}
    const id = `${path} [${short} ${++seq}]`;
    const title = `${basename(path)} (${short})`;
    const name = `${short}: ${basename(path)}`;
    if (text != null && (text.length > MAX_DIFF_BYTES || text.includes('\0'))) {
      return openMessageTab({ id, title, notes: [problemOf(name, text.includes('\0') ? { binary: true, size: text.length } : { tooLarge: true, size: text.length })], paths: [path] });
    }
    const doc = await documentOf(path);
    if (!doc || doc.unsupported || doc.error !== undefined) {
      return openMessageTab({ id, title, notes: [problemOf(basename(path), doc?.unsupported || { error: doc?.error || '' })], paths: [path] });
    }
    return openDiffTab({
      id, title, language: doc.model.getLanguageId(),
      left: { title: text == null ? { user: tr('{ref}: the file does not exist there', { ref: short }) } : { user: `${short}: ${rel(path)}` }, text: text ?? '' },
      right: { title: { user: rel(path) }, doc },
    });
  }

  // ---------- actions, menus, keys ----------
  const treeFocused = () => document.activeElement === document.getElementById('tree');
  const activeFile = () => ide.activeTab()?.doc?.path || null;
  async function compareAction() {
    if (treeFocused()) {
      const files = (ide.selectedTreeEntries?.() || []).filter((e) => !e.dir);
      if (files.length >= 2) return compareFiles(files[0].path, files[1].path);
      if (files.length === 1) return compareWith(files[0].path);
    }
    if (activeFile()) return compareWith(activeFile());
    ide.ui.alert(tr('Select two files in the Project tool window, or open a file, to compare.'));
    return null;
  }
  ide.registerAction({ id: 'CompareTwoFiles', title: tr('Compare With…'), keys: 'Ctrl+D', when: treeFocused, context: 'projectView', run: compareAction });
  ide.registerAction({ id: 'CompareClipboardWithSelection', title: tr('Compare with Clipboard'), run: () => compareWithClipboard(ide.editor) });
  ide.registerAction({ id: 'Git.CompareWithBranch', title: tr('Compare with Branch…'), run: () => compareWithBranch(activeFile()) });

  ide.registerTreeAction({ title: tr('Compare Files'), keyAction: 'CompareTwoFiles', when: (e, sel = []) => sel.length === 2 && sel.every((s) => !s.dir),
    run: (e, sel) => compareFiles(sel[0].path, sel[1].path) });
  ide.registerTreeAction({ title: tr('Compare With…'), keyAction: 'CompareTwoFiles', when: (e, sel = []) => !e.dir && sel.length <= 1, run: (e) => compareWith(e.path) });
  ide.registerTreeAction({ title: tr('Git: Compare with Branch…'), when: (e, sel = []) => !e.dir && sel.length <= 1 && inRepo(), run: (e) => compareWithBranch(e.path) });

  ide.onEditor((ed) => {
    ed.addAction({ id: 'pyide.compareWithClipboard', label: tr('Compare with Clipboard'), contextMenuGroupId: '9_cutcopypaste', contextMenuOrder: 6,
      run: () => compareWithClipboard(ed) });
  });

  // F7 / Shift+F7 in any diff tab: these and the vcs plugin's (its view keeps its diff editor on the host). The
  // debugger's F7 (Step Into) stands back while a diff tab has the keyboard (ide.compare.diffFocused), whatever the
  // registration order.
  const activeDiff = () => {
    const t = ide.activeTab();
    if (!t || t.kind !== 'custom') return null;
    const focus = document.activeElement;
    if (focus && focus !== document.body && !t.host?.contains(focus)) return null;
    return views.get(t)?.diff || t.host?._vcsDiff || null;
  };
  ide.on('ready', () => {
    ide.registerAction({ id: 'NextDiff', title: tr('Next Difference'), keys: 'F7', when: () => !!activeDiff(), run: () => { const d = activeDiff(); if (d) go(d, 1); } });
    ide.registerAction({ id: 'PreviousDiff', title: tr('Previous Difference'), keys: 'Shift+F7', when: () => !!activeDiff(), run: () => { const d = activeDiff(); if (d) go(d, -1); } });
  });

  ide.compare = {
    files: compareFiles, with: compareWith, clipboard: compareWithClipboard, branch: compareWithBranch, texts: compareTexts,
    // The diff view of a tab (tests, other plugins): {diff, go(dir), count(), ready(), setUnified(on)}.
    view: (tab = ide.activeTab()) => views.get(tab) || null,
    // Whether the active tab is a diff (this plugin's or the vcs plugin's) and the keyboard is in it (or nowhere).
    diffFocused: () => !!activeDiff(),
    MAX_DIFF_BYTES,
  };
})();
