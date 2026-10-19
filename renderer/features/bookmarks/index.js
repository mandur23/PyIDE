// Bookmarks (PyCharm's): F11 toggles a bookmark on the caret line, Ctrl+F11 adds one with a mnemonic (0-9, A-Z),
// Ctrl+Shift+digit toggles a numbered one, Ctrl+digit jumps to it, Shift+F11 lists them all and Alt+2 opens the
// Bookmarks tool window. Bookmarks are kept per project in settings. While their file is open they are model
// decorations, so they follow the lines as the text is edited.
(() => {
  const { el, basename, dirname, samePath, isUnder } = ide.util;
  const MNEMONICS = [...'0123456789ABCDEFGHIJKLMNOPQRSTUVWXYZ'];
  const settingKey = (root) => `bookmarks.${root}`;
  const userText = (tag, cls, text) => { const n = el(tag, cls, text); n.dataset.userText = ''; return n; };

  let marks = []; // {path, line, mnemonic?, description?, text}
  let root = null;
  const decorated = new Map(); // model -> {ids, marks, len}: decoration ids in the order of marks

  // One rule per mnemonic draws its character on the gutter icon.
  const mnemonicCss = el('style');
  mnemonicCss.textContent = MNEMONICS.map((c) => `.bm-m-${c}::after { content: '${c}'; }`).join('\n');
  document.head.appendChild(mnemonicCss);

  // ---------- persistence ----------
  let saveTimer = null;
  function save() {
    clearTimeout(saveTimer);
    saveTimer = null;
    if (!root) return;
    ide.settings.set(settingKey(root), marks.map((m) => ({
      path: ide.util.rel(m.path), line: m.line, text: m.text,
      ...(m.mnemonic ? { mnemonic: m.mnemonic } : {}), ...(m.description ? { description: m.description } : {}),
    })));
  }
  const scheduleSave = () => { clearTimeout(saveTimer); saveTimer = setTimeout(save, 400); };
  addEventListener('beforeunload', () => { if (saveTimer) save(); });

  function load(dir) {
    if (saveTimer) save();
    root = dir;
    marks = (ide.settings.get(settingKey(dir), []) || []).map((m) => ({ ...m, path: ide.util.joinPath(dir, m.path) }));
    for (const model of [...decorated.keys()]) decorate(model);
    render();
  }

  // ---------- gutter decorations ----------
  const modelPath = (model) => ide.tabs.find((t) => t.model === model)?.path || null;
  const lineText = (model, line) => model.getLineContent(line).trim().slice(0, 200);

  function decoration(m, model) {
    const M = ide.monaco;
    const line = Math.min(Math.max(1, m.line), model.getLineCount());
    return {
      range: new M.Range(line, 1, line, model.getLineMaxColumn(line)),
      options: {
        // The range covers the line's text: Enter at its start moves the bookmark down with the text.
        stickiness: M.editor.TrackedRangeStickiness.GrowsOnlyWhenTypingAfter,
        glyphMarginClassName: m.mnemonic ? `bm-glyph bm-mn bm-m-${m.mnemonic}` : 'bm-glyph',
        glyphMarginHoverMessage: { value: m.description || (m.mnemonic ? tr('Bookmark {mnemonic}', { mnemonic: m.mnemonic }) : tr('Bookmark')) },
        glyphMargin: { position: M.editor.GlyphMarginLane.Left },
        overviewRuler: { color: '#c9a227', position: M.editor.OverviewRulerLane.Right },
      },
    };
  }

  function decorate(model) {
    if (model.isDisposed()) { decorated.delete(model); return; }
    const path = modelPath(model);
    let st = decorated.get(model);
    if (!st) {
      st = { ids: [], marks: [], len: 0 };
      decorated.set(model, st);
      model.onDidChangeContent((e) => followEdits(model, e));
      model.onWillDispose(() => decorated.delete(model));
    }
    st.marks = path ? marks.filter((m) => samePath(m.path, path)) : [];
    st.ids = model.deltaDecorations(st.ids, st.marks.map((m) => decoration(m, model)));
    st.len = model.getValueLength();
  }

  const decorateFile = (path) => {
    for (const model of decorated.keys()) if (samePath(modelPath(model), path)) decorate(model);
    const doc = ide.getDocument(path);
    if (doc && !decorated.has(doc.model)) decorate(doc.model);
  };

  // Bookmarks move with their decorations. Replacing the whole text (reload from disk, git) would collapse every
  // decoration onto line 1, so the bookmarks keep their line numbers then.
  function followEdits(model, e) {
    const st = decorated.get(model);
    if (!st) return;
    const whole = e.isFlush || (e.changes.length === 1 && e.changes[0].rangeOffset === 0 && e.changes[0].rangeLength === st.len);
    st.len = model.getValueLength();
    if (!st.marks.length) return;
    if (whole) {
      decorate(model);
    } else {
      st.marks.forEach((m, i) => {
        const r = model.getDecorationRange(st.ids[i]);
        if (r) m.line = r.startLineNumber;
      });
    }
    for (const m of st.marks) m.text = lineText(model, Math.min(m.line, model.getLineCount()));
    scheduleSave();
    render();
  }

  // ---------- commands ----------
  const marksAt = (path, line) => marks.filter((m) => samePath(m.path, path) && m.line === line);

  function caret() {
    const ed = ide.editor;
    const model = ed?.getModel();
    const tab = ide.activeTab();
    if (!model || !tab?.doc || tab.model !== model || !ed.hasTextFocus()) return null;
    const line = ed.getPosition().lineNumber;
    return { path: tab.path, line, text: lineText(model, line) };
  }

  function changed(path) {
    decorateFile(path);
    scheduleSave();
    render();
  }

  function toggle() {
    const at = caret();
    if (!at) return;
    const existing = marksAt(at.path, at.line);
    if (existing.length) marks = marks.filter((m) => !existing.includes(m));
    else marks.push({ path: at.path, line: at.line, text: at.text });
    changed(at.path);
  }

  // Gives the caret line the mnemonic (taking it from any other bookmark), or removes that bookmark if it has it.
  function assign(at, mnemonic, description) {
    const mine = marksAt(at.path, at.line)[0];
    const other = marks.find((m) => m.mnemonic === mnemonic && m !== mine);
    if (other) { delete other.mnemonic; decorateFile(other.path); }
    if (mine) {
      mine.mnemonic = mnemonic;
      if (description !== undefined) mine.description = description;
    } else {
      marks.push({ path: at.path, line: at.line, text: at.text, mnemonic, ...(description ? { description } : {}) });
    }
    changed(at.path);
  }

  function toggleNumbered(digit) {
    const at = caret();
    if (!at) return;
    const mine = marksAt(at.path, at.line)[0];
    if (mine?.mnemonic === digit) { marks = marks.filter((m) => m !== mine); changed(at.path); } else assign(at, digit);
  }

  function goTo(m) {
    if (m) ide.openFile(m.path, { line: m.line });
  }
  const gotoMnemonic = (c) => goTo(marks.find((m) => m.mnemonic === c));

  function remove(list) {
    marks = marks.filter((m) => !list.includes(m));
    for (const p of new Set(list.map((m) => m.path))) changed(p);
  }

  async function editDescription(m) {
    if (!m) return;
    const text = await ide.ui.prompt(tr('Bookmark description'), m.description || '');
    if (text === null) return;
    if (text) m.description = text; else delete m.description;
    changed(m.path);
  }

  // Ctrl+F11: a grid of mnemonics; typing one assigns it at once, as in PyCharm.
  function mnemonicDialog() {
    const at = caret();
    if (!at) return;
    const mine = marksAt(at.path, at.line)[0];
    let chosen = mine?.mnemonic || null;
    const body = el('div', 'bm-dialog');
    body.appendChild(el('div', 'muted', tr('Press a digit or a letter to assign it to this line.')));
    const grid = el('div', 'bm-grid');
    grid.tabIndex = 0;
    const cells = new Map();
    for (const c of MNEMONICS) {
      const cell = el('button', 'bm-cell', c);
      const used = marks.find((m) => m.mnemonic === c && m !== mine);
      if (used) { cell.classList.add('used'); cell.title = `${basename(used.path)}:${used.line}`; }
      cell.onclick = () => choose(c);
      cells.set(c, cell);
      grid.appendChild(cell);
    }
    const desc = el('input', 'bm-desc');
    desc.placeholder = tr('Description (optional)');
    desc.value = mine?.description || '';
    const field = el('label', 'field');
    field.append(el('span', null, tr('Description:')), desc);
    body.append(grid, field);
    const choose = (c) => {
      chosen = c;
      for (const [k, cell] of cells) cell.classList.toggle('selected', k === c);
    };
    if (chosen) choose(chosen);
    const apply = () => { if (chosen) assign(at, chosen, desc.value.trim()); };
    const dlg = ide.ui.dialog({
      title: mine ? tr('Edit Mnemonic Bookmark') : tr('Add Mnemonic Bookmark'), body, width: 440,
      buttons: [
        { label: tr('OK'), primary: true, run: () => { if (!chosen) return false; apply(); } },
        ...(mine ? [{ label: tr('Delete'), run: () => remove([mine]) }] : []),
        { label: tr('Cancel') },
      ],
      onClose: () => ide.editor?.focus(),
    });
    grid.onkeydown = (e) => {
      const c = e.key.length === 1 && !e.ctrlKey && !e.altKey && e.key.toUpperCase();
      if (!c || !MNEMONICS.includes(c)) return;
      e.preventDefault();
      choose(c);
      apply();
      dlg.close();
    };
    grid.focus();
  }

  const markLabel = (m) => `${m.mnemonic ? `[${m.mnemonic}] ` : ''}${basename(m.path)}:${m.line}`;

  async function showPopup() {
    if (!marks.length) return;
    const m = await ide.ui.pick({
      placeholder: tr('Bookmarks'),
      items: sorted().map((x) => ({ label: markLabel(x), detail: x.description || x.text, icon: '🔖', value: x })),
    });
    goTo(m);
  }

  // ---------- tool window ----------
  let listEl = null;
  let selected = null;
  const sorted = () => [...marks].sort((a, b) => a.path.localeCompare(b.path) || a.line - b.line);

  function render() {
    if (!listEl) return;
    listEl.replaceChildren();
    if (!marks.length) {
      listEl.appendChild(el('div', 'bm-empty muted', tr('No bookmarks. Press F11 in the editor to add one.')));
      return;
    }
    if (!marks.includes(selected)) selected = null;
    let file = null;
    for (const m of sorted()) {
      if (!samePath(file, m.path)) {
        file = m.path;
        const head = el('div', 'bm-file');
        head.append(el('span', 'bm-file-icon', m.path.endsWith('.py') ? '🐍' : '📄'), userText('span', 'bm-file-name', basename(m.path)),
          userText('span', 'bm-file-dir muted', ide.util.rel(dirname(m.path))));
        listEl.appendChild(head);
      }
      const row = el('div', `bm-row${m === selected ? ' selected' : ''}`);
      row.appendChild(el('span', `bm-badge${m.mnemonic ? ' mn' : ''}`, m.mnemonic || ''));
      row.appendChild(el('span', 'bm-line', `${m.line}`));
      row.appendChild(userText('span', 'bm-text', m.description || m.text || ''));
      if (m.description && m.text) row.appendChild(userText('span', 'bm-code muted', m.text));
      row.onclick = () => { selected = m; render(); goTo(m); };
      row.oncontextmenu = (e) => {
        e.preventDefault();
        selected = m;
        render();
        ide.ui.contextMenu(e.clientX, e.clientY, [
          { label: tr('Jump to Source'), run: () => goTo(m) },
          { label: tr('Edit Description…'), run: () => editDescription(m) },
          { separator: true },
          { label: tr('Delete'), hint: 'Delete', run: () => remove([m]) },
        ]);
      };
      row._mark = m;
      listEl.appendChild(row);
    }
  }

  const bookmarksTw = ide.registerToolWindow({
    id: 'Bookmarks', title: tr('Bookmarks'), icon: '🔖', iconName: 'bookmarks', side: 'left', keys: 'Alt+2', order: 25,
    mount(container, tw) {
      listEl = el('div', 'bm-list');
      listEl.tabIndex = 0;
      listEl.onkeydown = (e) => {
        const list = sorted();
        if (e.key === 'Delete' && selected) { e.preventDefault(); remove([selected]); return; }
        if (e.key === 'Enter' && selected) { e.preventDefault(); goTo(selected); return; }
        if (e.key !== 'ArrowDown' && e.key !== 'ArrowUp') return;
        e.preventDefault();
        const i = list.indexOf(selected);
        selected = list[Math.max(0, Math.min(list.length - 1, i + (e.key === 'ArrowDown' ? 1 : -1)))] || null;
        render();
      };
      container.appendChild(listEl);
      tw.setActions([
        { icon: '✎', title: tr('Edit Description…'), run: () => editDescription(selected) },
        { icon: '✕', title: tr('Delete'), run: () => selected && remove([selected]) },
      ]);
      render();
    },
  });

  // ---------- wiring ----------
  const inEditor = () => !!caret();
  [
    { id: 'ToggleBookmark', title: tr('Toggle Bookmark'), keys: 'F11', when: inEditor, run: toggle },
    { id: 'ToggleBookmarkWithMnemonic', title: tr('Toggle Bookmark with Mnemonic'), keys: 'Ctrl+F11', when: inEditor, run: mnemonicDialog },
    { id: 'ShowBookmarks', title: tr('Show Bookmarks'), keys: 'Shift+F11', run: showPopup },
    // Ctrl+1..3 focus editor groups (core) unless that numbered bookmark exists.
    ...[...'0123456789'].flatMap((d) => [
      { id: `GotoBookmark${d}`, title: tr('Go to Bookmark {mnemonic}', { mnemonic: d }), keys: `Ctrl+${d}`, when: () => marks.some((m) => m.mnemonic === d), run: () => gotoMnemonic(d) },
      { id: `ToggleBookmark${d}`, title: tr('Toggle Bookmark {mnemonic}', { mnemonic: d }), keys: `Ctrl+Shift+${d}`, when: inEditor, run: () => toggleNumbered(d) },
    ]),
  ].forEach(ide.registerAction);

  ide.onEditor((ed) => {
    ed.addAction({ id: 'bookmarks.toggle', label: tr('Toggle Bookmark'), contextMenuGroupId: '8_bookmarks', run: () => { ed.focus(); toggle(); } });
    ed.addAction({ id: 'bookmarks.mnemonic', label: tr('Toggle Bookmark with Mnemonic'), contextMenuGroupId: '8_bookmarks', run: () => { ed.focus(); mnemonicDialog(); } });
  });

  ide.on('projectOpened', load);
  ide.on('projectClosed', () => { if (saveTimer) save(); root = null; marks = []; render(); });
  ide.on('fileOpened', (tab) => { if (tab.model && marks.some((m) => samePath(m.path, tab.path))) decorate(tab.model); });
  ide.on('filesChanged', (e) => {
    for (const [from, to] of e?.renamed || []) {
      for (const m of marks) if (isUnder(m.path, from)) m.path = to + m.path.slice(from.length);
    }
    const gone = marks.filter((m) => (e?.deleted || []).some((d) => isUnder(m.path, d)));
    if (gone.length) remove(gone);
    else if (e?.renamed?.length) { scheduleSave(); render(); }
  });

  ide.bookmarks = {
    list: () => sorted().map((m) => ({ ...m })),
    toggle, gotoMnemonic, showPopup,
    show: () => bookmarksTw.show(),
  };
})();
