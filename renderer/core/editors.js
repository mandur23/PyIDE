// Editor area: documents, editor groups (split panes) with their tabs, file viewers, and detached windows.
//
// A document (one per file) owns the Monaco model, its saved version and its encoding. A group is one pane with a
// tab bar and its own Monaco editor; the same document can be open in several groups (they share the model, so
// edits show everywhere). Groups are arranged in a binary split tree. `ide.editor` is the active group's editor.
(() => {
  const { $, el, basename, dirname, samePath, isUnder } = ide.util;
  const key = (p) => p.toLowerCase();

  const LANG_BY_EXT = { py: 'python', pyw: 'python', pyi: 'python', js: 'javascript', mjs: 'javascript', cjs: 'javascript',
    ts: 'typescript', json: 'json', jsonl: 'json', md: 'markdown', html: 'html', htm: 'html', css: 'css', yml: 'yaml',
    yaml: 'yaml', toml: 'ini', cfg: 'ini', ini: 'ini', xml: 'xml', sh: 'shell', bat: 'bat', cmd: 'bat', ps1: 'powershell',
    sql: 'sql', txt: 'plaintext', log: 'plaintext', java: 'java', kt: 'kotlin', lua: 'lua', luau: 'lua', cs: 'csharp',
    c: 'c', cpp: 'cpp', h: 'cpp', go: 'go', rs: 'rust', jsp: 'html', fxml: 'xml', dockerfile: 'dockerfile' };
  const languageFor = (p) => LANG_BY_EXT[p.split('.').pop().toLowerCase()] || 'plaintext';

  const docs = new Map(); // path key -> {path, model, savedVersion, encoding}
  const groups = [];
  let layout = null; // {kind: 'leaf', group} | {kind: 'split', dir: 'row'|'column', a, b, ratio}
  let activeGroup = null;
  let groupSeq = 0;
  const viewers = [];
  const editorHooks = new Set();
  const embedded = new Set(); // editors created by viewers through ide.createEditor
  const closedTabs = [];
  const mru = []; // most recently activated tabs, newest first
  let editorOptions = {};
  let peers = 1;
  let applyingRemote = false;

  const settingOn = (k, d) => ide.settings.get(k, d);

  // ---------- documents ----------
  async function loadDoc(path) {
    const existing = docs.get(key(path));
    if (existing) return existing;
    const r = await ide.api.invoke('fs:readText', path);
    if (r.binary || r.tooLarge) return { unsupported: r };
    const again = docs.get(key(path));
    if (again) return again;
    const uri = ide.monaco.Uri.file(path);
    const model = ide.monaco.editor.getModel(uri) || ide.monaco.editor.createModel(r.text, languageFor(path), uri);
    // fresh: fileOpened is announced once the first tab for it exists. diskHash fingerprints the text last read from
    // or written to the file, so auto save can tell when the file changed underneath.
    const doc = { path, model, savedVersion: model.getAlternativeVersionId(), encoding: r.encoding, fresh: true, diskHash: textHash(r.text), changed: [] };
    docs.set(key(path), doc);
    model.onDidChangeContent((e) => {
      // The tab bars change only when the modified mark does, not on every keystroke.
      if (docDirty(doc) !== doc.shownDirty) scheduleRender(); else reportDirty();
      markChanged(doc, e);
      if (!applyingRemote) syncOut(doc);
    });
    if (peers > 1) ide.api.send('doc:opened', { path });
    return doc;
  }

  const docDirty = (doc) => !!doc && !doc.model.isDisposed() && doc.model.getAlternativeVersionId() !== doc.savedVersion;
  const tabsOfDoc = (doc) => groups.flatMap((g) => g.tabs.filter((t) => t.doc === doc));
  const firstTabFor = (doc) => tabsOfDoc(doc)[0] || null;

  function releaseDoc(doc) {
    if (tabsOfDoc(doc).length) return;
    docs.delete(key(doc.path));
    doc.model.dispose();
    ide.emit('fileClosed', doc.path);
  }

  const textHash = (s) => {
    let h = 0x811c9dc5;
    for (let i = 0; i < s.length; i++) h = Math.imul(h ^ s.charCodeAt(i), 16777619);
    return `${s.length}:${h >>> 0}`;
  };

  // Lines edited since the last save, kept as whole-line decorations so they move with the text.
  function markChanged(doc, e) {
    const m = doc.model;
    if (e.isFlush) return;
    const marks = e.changes.map((c) => {
      const start = Math.min(c.range.startLineNumber, m.getLineCount());
      const end = Math.min(start + (c.text.match(/\n/g)?.length || 0), m.getLineCount());
      return { range: new ide.monaco.Range(start, 1, end, m.getLineMaxColumn(end)), options: { isWholeLine: true } };
    });
    if (doc.changed.length > 200) doc.changed = m.deltaDecorations(doc.changed, lineRanges(changedLines(doc)));
    doc.changed = doc.changed.concat(m.deltaDecorations([], marks));
  }
  function changedLines(doc) {
    const lines = new Set();
    for (const id of doc.changed) {
      const r = doc.model.getDecorationRange(id);
      if (r) for (let l = r.startLineNumber; l <= r.endLineNumber; l++) lines.add(l);
    }
    return lines;
  }
  function lineRanges(lines) {
    const out = [];
    for (const l of [...lines].sort((a, b) => a - b)) {
      const last = out[out.length - 1];
      if (last && last.range.endLineNumber === l - 1) last.range = last.range.setEndPosition(l, 1);
      else out.push({ range: new ide.monaco.Range(l, 1, l, 1), options: { isWholeLine: true } });
    }
    return out;
  }
  const clearChanged = (doc) => { if (!doc.model.isDisposed()) doc.changed = doc.model.deltaDecorations(doc.changed, []); };

  // ---------- multi-window document sync ----------
  const syncTimers = new Map();
  function syncOut(doc) {
    if (peers < 2) return;
    clearTimeout(syncTimers.get(doc));
    syncTimers.set(doc, setTimeout(() => {
      syncTimers.delete(doc);
      if (!doc.model.isDisposed()) ide.api.send('doc:changed', { path: doc.path, text: doc.model.getValue() });
    }, 120));
  }

  // Applies another window's text as one minimal edit so cursors and undo history survive.
  function applyRemoteText(doc, text) {
    const cur = doc.model.getValue();
    if (cur === text) return;
    let start = 0;
    while (start < cur.length && start < text.length && cur[start] === text[start]) start++;
    let endCur = cur.length;
    let endNew = text.length;
    while (endCur > start && endNew > start && cur[endCur - 1] === text[endNew - 1]) { endCur--; endNew--; }
    const range = ide.monaco.Range.fromPositions(doc.model.getPositionAt(start), doc.model.getPositionAt(endCur));
    applyingRemote = true;
    try { doc.model.pushEditOperations([], [{ range, text: text.slice(start, endNew) }], () => null); } finally { applyingRemote = false; }
  }

  ide.api.on('window:peers', (n) => { peers = n; });
  ide.api.on('doc:changed', ({ path, text }) => { const d = docs.get(key(path)); if (d) applyRemoteText(d, text); });
  ide.api.on('doc:saved', ({ path, text }) => {
    const d = docs.get(key(path));
    if (d && d.model.getValue() === text) { d.savedVersion = d.model.getAlternativeVersionId(); d.diskHash = textHash(text); clearChanged(d); renderAllTabs(); }
  });
  ide.api.on('doc:opened', ({ path }) => {
    const d = docs.get(key(path));
    if (d && docDirty(d)) ide.api.send('doc:changed', { path: d.path, text: d.model.getValue() });
  });

  // ---------- tabs ----------
  function makeFileTab(doc, group) {
    return {
      kind: 'file', group, doc, pinned: false, preview: false, viewState: null,
      get path() { return doc.path; },
      get title() { return basename(doc.path); },
      get model() { return doc.model; },
      get savedVersion() { return doc.savedVersion; },
      set savedVersion(v) { doc.savedVersion = v; },
    };
  }

  const tabIcon = (t) => (t.kind === 'custom' ? el('span', 'tab-icon', t.icon) : Object.assign(ide.fileIcon(t.path), { className: 'file-icon tab-icon' }));

  function addTab(g, tab, index) {
    tab.group = g;
    const pinnedCount = g.tabs.filter((t) => t.pinned).length;
    const at = index === undefined ? g.tabs.length : Math.max(tab.pinned ? 0 : pinnedCount, Math.min(index, g.tabs.length));
    g.tabs.splice(at, 0, tab);
    enforceTabLimit(g, tab);
  }

  // PyCharm's tab limit: the least recently used unpinned, unmodified tab closes when a group overflows.
  function enforceTabLimit(g, keep) {
    const limit = Number(settingOn('editor.tabLimit', 10)) || 0;
    while (limit > 0 && g.tabs.length > limit) {
      const victim = [...g.tabs].sort((a, b) => mruRank(b) - mruRank(a))
        .find((t) => t !== keep && !t.pinned && !ide.isDirty(t));
      if (!victim) break;
      closeTabObj(victim, true);
    }
  }
  const mruRank = (t) => { const i = mru.indexOf(t); return i < 0 ? Infinity : i; };

  function activateTab(g, tab, { focus = false } = {}) {
    if (g.active && g.active !== tab && g.active.kind === 'file' && g.editor.getModel() === g.active.model) {
      g.active.viewState = g.editor.saveViewState();
    }
    g.active = tab;
    if (tab) {
      const i = mru.indexOf(tab);
      if (i >= 0) mru.splice(i, 1);
      mru.unshift(tab);
    }
    showSurface(g);
    if (tab?.kind === 'file') {
      if (g.editor.getModel() !== tab.model) g.editor.setModel(tab.model);
      if (tab.viewState) g.editor.restoreViewState(tab.viewState);
    } else g.editor.setModel(null);
    renderTabs(g);
    if (g === activeGroup) { updateStatus(); ide.emit('activeTabChanged', tab || null); }
    if (focus) focusGroup(g);
  }

  function showSurface(g) {
    const t = g.active;
    g.editorHost.classList.toggle('hidden', !t || t.kind !== 'file');
    for (const o of g.tabs) o.host?.classList.toggle('hidden', o !== t);
    g.empty.classList.toggle('hidden', !!t || ide.detached);
    if (t?.kind === 'file') g.editor.layout();
  }

  function focusGroup(g) {
    if (g.active?.kind === 'file') g.editor.focus();
    else g.active?.host?.focus?.();
  }

  function setActiveGroup(g) {
    if (!g || activeGroup === g) return;
    activeGroup = g;
    for (const o of groups) o.el.classList.toggle('active-group', o === g);
    updateStatus();
    ide.emit('activeEditorChanged', g.editor);
    ide.emit('activeTabChanged', g.active || null);
  }

  function renderTabs(g) {
    const bar = g.tabList;
    bar.replaceChildren();
    for (const t of g.tabs) {
      const node = el('div', 'tab' + (t === g.active ? ' active' : '') + (t.preview ? ' preview' : '') + (t.pinned ? ' pinned' : ''));
      node.title = t.path;
      node.draggable = true;
      node.dataset.path = t.path;
      node.appendChild(tabIcon(t));
      node.appendChild(el('span', 'name', t.title));
      const dirty = ide.isDirty(t);
      if (t.doc) t.doc.shownDirty = dirty;
      if (dirty) node.appendChild(el('span', 'dirty', '●'));
      if (t.pinned) node.appendChild(el('span', 'pin', '📌'));
      const close = el('button', 'close', '×');
      close.title = tr('Close');
      node.appendChild(close);
      node.onclick = () => { setActiveGroup(g); activateTab(g, t, { focus: true }); };
      node.ondblclick = () => { if (t.preview) { t.preview = false; renderTabs(g); } else toggleMaximizeEditor(); };
      node.onauxclick = (e) => e.button === 1 && closeTabObj(t);
      node.oncontextmenu = (e) => { e.preventDefault(); setActiveGroup(g); showTabMenu(t, e.clientX, e.clientY); };
      node.ondragstart = (e) => {
        e.dataTransfer.setData('application/x-pyide-tab', JSON.stringify({ group: g.id, path: t.path }));
        e.dataTransfer.effectAllowed = 'copyMove';
        dragging = t;
      };
      node.ondragend = () => { dragging = null; hideDropOverlay(); };
      close.onclick = (e) => { e.stopPropagation(); closeTabObj(t); };
      bar.appendChild(node);
    }
    bar.querySelector('.tab.active')?.scrollIntoView({ block: 'nearest', inline: 'nearest' });
  }

  function renderAllTabs() {
    for (const g of groups) renderTabs(g);
    reportDirty();
  }
  let renderQueued = false;
  const scheduleRender = () => {
    // Reported now, not on the next frame: a window that renders no frames (hidden, occluded) must still ask
    // before closing with unsaved changes.
    reportDirty();
    if (renderQueued) return;
    renderQueued = true;
    requestAnimationFrame(() => { renderQueued = false; renderAllTabs(); });
  };

  let lastDirty = false;
  function reportDirty() {
    const any = [...docs.values()].some(docDirty);
    if (any !== lastDirty) { lastDirty = any; ide.api.send('window:setDirty', any); }
  }

  // Returns false when the user cancelled closing a modified document.
  function closeTabObj(tab, force = false, { moving = false } = {}) {
    const g = tab.group;
    const i = g.tabs.indexOf(tab);
    if (i < 0) return true;
    const last = tab.doc && tabsOfDoc(tab.doc).length === 1;
    if (!force && last && docDirty(tab.doc) && !confirm(tr('{name} has unsaved changes. Close anyway?', { name: tab.title }))) return false;
    g.tabs.splice(i, 1);
    const m = mru.indexOf(tab);
    if (m >= 0) mru.splice(m, 1);
    if (!moving) {
      closedTabs.push({ path: tab.path, kind: tab.kind, viewer: tab.viewer?.id });
      if (closedTabs.length > 30) closedTabs.shift();
    }
    // A viewer or plugin tab that fails to clean up must not leave the tab half closed.
    if (tab.kind === 'custom') {
      safe(() => tab.dispose?.());
      safe(() => tab.onClose?.());
      tab.host.remove();
    }
    if (tab.doc) releaseDoc(tab.doc);
    else if (tab.kind === 'custom') ide.emit('fileClosed', tab.path);
    if (g.active === tab) {
      const next = mru.find((t) => t.group === g) || g.tabs[Math.min(i, g.tabs.length - 1)] || null;
      activateTab(g, next);
    } else renderTabs(g);
    if (!g.tabs.length) {
      if (groups.length > 1) removeGroup(g);
      else if (ide.detached) window.close();
    }
    reportDirty();
    return true;
  }

  // ---------- groups and split layout ----------
  function createGroup() {
    const g = { id: ++groupSeq, tabs: [], active: null };
    g.el = el('div', 'editor-group');
    g.el.dataset.group = g.id;
    const bar = el('div', 'group-tabs');
    g.tabList = el('div', 'tab-list');
    const actions = el('div', 'group-actions');
    const splitBtn = el('button', null, '◫');
    splitBtn.title = tr('Split Right');
    splitBtn.onclick = () => splitGroup(g, 'right', g.active, { clone: true });
    const more = el('button', null, '⋮');
    more.title = tr('More');
    more.onclick = (e) => { const r = more.getBoundingClientRect(); showGroupMenu(g, r.left, r.bottom); e.stopPropagation(); };
    actions.append(splitBtn, more);
    bar.append(g.tabList, actions);
    g.body = el('div', 'group-body');
    g.editorHost = el('div', 'editor-host');
    g.customHost = el('div', 'custom-host');
    g.empty = el('div', 'group-empty');
    for (const [label, keys] of [[tr('Search Everywhere'), tr('Double Shift')], [tr('Go to File'), 'Ctrl+Shift+N'], [tr('Recent Files'), 'Ctrl+E'], [tr('Split Right'), 'Ctrl+\\'], [tr('Drop files here to open them'), '']]) {
      const row = el('div', 'empty-row');
      row.append(el('span', null, label), el('kbd', null, keys));
      if (!keys) row.lastChild.remove();
      g.empty.appendChild(row);
    }
    if (!groups.length) { g.editorHost.id = 'editor'; g.customHost.id = 'customHost'; g.tabList.id = 'tabs'; }
    g.body.append(g.editorHost, g.customHost, g.empty);
    g.el.append(bar, g.body);
    g.editor = ide.monaco.editor.create(g.editorHost, { ...editorOptions, model: null });
    g.editor.onDidFocusEditorWidget(() => setActiveGroup(g));
    g.el.addEventListener('mousedown', () => setActiveGroup(g), true);
    g.editor.onDidChangeCursorPosition((e) => { if (g === activeGroup) $('statusPos').textContent = `${e.position.lineNumber}:${e.position.column}`; });
    g.editor.onDidChangeModelContent(() => {
      const t = g.active;
      if (t?.preview) { t.preview = false; renderTabs(g); }
    });
    wireDrop(g);
    groups.push(g);
    for (const fn of editorHooks) safe(() => fn(g.editor));
    ide.emit('editorCreated', g.editor);
    return g;
  }
  const safe = (fn) => { try { fn(); } catch (err) { console.error(err); } };

  function findParent(node, target, parent = null) {
    if (node === target) return { parent };
    if (node.kind !== 'split') return null;
    return findParent(node.a, target, node) || findParent(node.b, target, node);
  }
  const leafOf = (node, g) => (node.kind === 'leaf' ? (node.group === g ? node : null) : leafOf(node.a, g) || leafOf(node.b, g));
  const firstGroup = (node) => (node.kind === 'leaf' ? node.group : firstGroup(node.a));

  function renderLayout() {
    const area = $('editorGroups');
    const build = (node) => {
      if (node.kind === 'leaf') { node.group.el.style.flex = ''; return node.group.el; }
      const box = el('div', `split split-${node.dir}`);
      const a = build(node.a);
      const b = build(node.b);
      a.style.flex = `${node.ratio} 1 0`;
      b.style.flex = `${1 - node.ratio} 1 0`;
      const handle = el('div', 'split-handle');
      handle.onmousedown = (down) => {
        down.preventDefault();
        const r = box.getBoundingClientRect();
        const move = (e) => {
          const pos = node.dir === 'row' ? (e.clientX - r.left) / r.width : (e.clientY - r.top) / r.height;
          node.ratio = Math.min(0.9, Math.max(0.1, pos));
          a.style.flex = `${node.ratio} 1 0`;
          b.style.flex = `${1 - node.ratio} 1 0`;
        };
        const up = () => { removeEventListener('mousemove', move); removeEventListener('mouseup', up); };
        addEventListener('mousemove', move);
        addEventListener('mouseup', up);
      };
      handle.ondblclick = () => { node.ratio = 0.5; renderLayout(); };
      box.append(a, handle, b);
      return box;
    };
    area.replaceChildren(build(layout));
    for (const g of groups) g.editor.layout();
  }

  // side: 'right' | 'left' | 'down' | 'up'. With a tab: clone it into the new group, or move it when clone is false.
  function splitGroup(g, side, tab, { clone = true } = {}) {
    const ng = createGroup();
    const leaf = leafOf(layout, g);
    const newLeaf = { kind: 'leaf', group: ng };
    const before = side === 'left' || side === 'up';
    const split = { kind: 'split', dir: side === 'left' || side === 'right' ? 'row' : 'column', ratio: 0.5,
      a: before ? newLeaf : { ...leaf }, b: before ? { ...leaf } : newLeaf };
    Object.keys(leaf).forEach((k) => delete leaf[k]);
    Object.assign(leaf, split);
    renderLayout();
    if (tab) placeTab(tab, ng, { clone });
    else activateTab(ng, null);
    setActiveGroup(ng);
    focusGroup(ng);
    return ng;
  }

  function removeGroup(g) {
    const leaf = leafOf(layout, g);
    const { parent } = findParent(layout, leaf) || {};
    if (!parent) return;
    const sibling = parent.a === leaf ? parent.b : parent.a;
    Object.keys(parent).forEach((k) => delete parent[k]);
    Object.assign(parent, sibling);
    groups.splice(groups.indexOf(g), 1);
    g.editor.dispose();
    g.el.remove();
    // The first group keeps the stable ids (#editor, #customHost, #tabs) that plugins and tests rely on.
    if (g.editorHost.id === 'editor' && groups[0]) {
      groups[0].editorHost.id = 'editor';
      groups[0].customHost.id = 'customHost';
      groups[0].tabList.id = 'tabs';
    }
    renderLayout();
    if (activeGroup === g) { activeGroup = null; setActiveGroup(firstGroup(layout)); }
  }

  // Moves or clones a tab into a group. Custom tabs (viewers, diffs) always move.
  function placeTab(tab, target, { clone = false, index } = {}) {
    if (tab.group === target) {
      if (index !== undefined) {
        const from = target.tabs.indexOf(tab);
        target.tabs.splice(from, 1);
        target.tabs.splice(index > from ? index - 1 : index, 0, tab);
      }
      activateTab(target, tab, { focus: true });
      return tab;
    }
    if (tab.kind === 'file') {
      let t = target.tabs.find((o) => o.doc === tab.doc);
      if (!t) {
        t = makeFileTab(tab.doc, target);
        t.viewState = tab.group.editor.getModel() === tab.model ? tab.group.editor.saveViewState() : tab.viewState;
        t.pinned = tab.pinned;
        addTab(target, t, index);
      }
      if (!clone) closeTabObj(tab, true, { moving: true });
      setActiveGroup(target);
      activateTab(target, t, { focus: true });
      return t;
    }
    const src = tab.group;
    src.tabs.splice(src.tabs.indexOf(tab), 1);
    target.customHost.appendChild(tab.host);
    addTab(target, tab, index);
    if (src.active === tab) activateTab(src, mru.find((t) => t.group === src) || src.tabs[0] || null);
    else renderTabs(src);
    setActiveGroup(target);
    activateTab(target, tab, { focus: true });
    if (!src.tabs.length && groups.length > 1) removeGroup(src);
    return tab;
  }

  function oppositeGroup(g) {
    if (groups.length < 2) return null;
    return groups[(groups.indexOf(g) + 1) % groups.length];
  }

  function unsplitAll() {
    const keep = activeGroup;
    for (const g of [...groups]) {
      if (g === keep) continue;
      for (const t of [...g.tabs]) placeTab(t, keep, { clone: false });
    }
  }

  // ---------- drag and drop ----------
  let dragging = null;
  const overlay = el('div', 'drop-overlay hidden');
  document.body.appendChild(overlay);
  const hideDropOverlay = () => overlay.classList.add('hidden');

  function dropZone(g, e) {
    const r = g.body.getBoundingClientRect();
    const x = (e.clientX - r.left) / r.width;
    const y = (e.clientY - r.top) / r.height;
    const edge = 0.22;
    if (x < edge) return 'left';
    if (x > 1 - edge) return 'right';
    if (y < edge) return 'up';
    if (y > 1 - edge) return 'down';
    return 'center';
  }

  function showDropOverlay(g, zone) {
    const r = g.body.getBoundingClientRect();
    const box = { left: r.left, top: r.top, width: r.width, height: r.height };
    if (zone === 'left' || zone === 'right') box.width = r.width / 2;
    if (zone === 'right') box.left = r.left + r.width / 2;
    if (zone === 'up' || zone === 'down') box.height = r.height / 2;
    if (zone === 'down') box.top = r.top + r.height / 2;
    Object.assign(overlay.style, { left: `${box.left}px`, top: `${box.top}px`, width: `${box.width}px`, height: `${box.height}px` });
    overlay.classList.remove('hidden');
  }

  const hasTabData = (e) => [...e.dataTransfer.types].includes('application/x-pyide-tab');
  const hasFiles = (e) => [...e.dataTransfer.types].includes('Files');
  // A row dragged from the project tree carries its path.
  const treePath = (e) => ([...e.dataTransfer.types].includes(ide.TREE_PATH_TYPE) ? e.dataTransfer.getData(ide.TREE_PATH_TYPE) || true : null);

  function wireDrop(g) {
    g.body.addEventListener('dragover', (e) => {
      if (!hasTabData(e) && !hasFiles(e) && !treePath(e)) return;
      e.preventDefault();
      e.dataTransfer.dropEffect = e.ctrlKey ? 'copy' : 'move';
      showDropOverlay(g, dropZone(g, e));
    });
    g.body.addEventListener('dragleave', (e) => { if (!g.body.contains(e.relatedTarget)) hideDropOverlay(); });
    g.body.addEventListener('drop', (e) => {
      e.preventDefault();
      e.stopPropagation();
      hideDropOverlay();
      const zone = dropZone(g, e);
      if (hasFiles(e)) return openDroppedFiles(e, zone === 'center' ? g : splitGroup(g, zone, null));
      if (treePath(e)) return ide.openFile(treePath(e), { group: zone === 'center' ? g : splitGroup(g, zone, null) });
      const tab = dragging;
      if (!tab) return;
      if (zone === 'center') placeTab(tab, g, { clone: e.ctrlKey });
      else if (tab.group === g && g.tabs.length === 1) return;
      else {
        const ng = splitGroup(g, zone, null);
        placeTab(tab, ng, { clone: e.ctrlKey });
      }
    });
    g.tabList.addEventListener('dragover', (e) => {
      if (!hasTabData(e) && !hasFiles(e) && !treePath(e)) return;
      e.preventDefault();
      hideDropOverlay();
      for (const n of g.tabList.children) n.classList.remove('drop-before', 'drop-after');
      const target = e.target.closest('.tab');
      if (target) target.classList.add(e.clientX < target.getBoundingClientRect().left + target.offsetWidth / 2 ? 'drop-before' : 'drop-after');
    });
    g.tabList.addEventListener('dragleave', () => { for (const n of g.tabList.children) n.classList.remove('drop-before', 'drop-after'); });
    g.tabList.addEventListener('drop', (e) => {
      e.preventDefault();
      e.stopPropagation();
      for (const n of g.tabList.children) n.classList.remove('drop-before', 'drop-after');
      if (hasFiles(e)) return openDroppedFiles(e, g);
      if (treePath(e)) return ide.openFile(treePath(e), { group: g });
      const tab = dragging;
      if (!tab) return;
      const target = e.target.closest('.tab');
      let index = g.tabs.length;
      if (target) {
        const i = [...g.tabList.children].indexOf(target);
        index = e.clientX < target.getBoundingClientRect().left + target.offsetWidth / 2 ? i : i + 1;
      }
      placeTab(tab, g, { clone: e.ctrlKey, index });
    });
  }

  // Files and folders dragged in from Explorer: a folder opens as the project, files open in the target group.
  async function openDroppedFiles(e, group) {
    const paths = [...e.dataTransfer.files].map((f) => ide.api.pathForFile(f)).filter(Boolean);
    for (const p of paths) {
      const listing = await ide.api.list(p).then(() => true, () => false);
      if (listing && !ide.detached) { await ide.openProject(p); return; }
      if (!listing) await ide.openFile(p, { group });
    }
  }
  document.addEventListener('dragover', (e) => { if (hasFiles(e)) e.preventDefault(); });
  document.addEventListener('drop', (e) => {
    if (!hasFiles(e)) return;
    e.preventDefault();
    hideDropOverlay();
    openDroppedFiles(e, activeGroup);
  });

  // ---------- public API ----------
  delete ide.editor;
  Object.defineProperty(ide, 'editor', { get: () => activeGroup?.editor || null, configurable: true });
  delete ide.tabs;
  // One entry per open document (the copy in the active group when it is split) plus custom tabs.
  Object.defineProperty(ide, 'tabs', { get: () => {
    const seen = new Set();
    const out = [];
    const ordered = activeGroup ? [activeGroup, ...groups.filter((g) => g !== activeGroup)] : groups;
    for (const g of ordered) for (const t of g.tabs) {
      const k = t.doc || t;
      if (seen.has(k)) continue;
      seen.add(k);
      out.push(t);
    }
    return out;
  }, configurable: true });
  delete ide.active;
  Object.defineProperty(ide, 'active', { get: () => activeGroup?.active?.path || null, configurable: true });

  ide.editors = () => groups.map((g) => g.editor);
  ide.groups = () => groups.map((g) => ({ id: g.id, tabs: [...g.tabs], active: g.active, editor: g.editor, el: g.el }));
  ide.activeGroup = () => activeGroup;
  // Runs fn for every editor, now and when new split panes are created. Returns an unsubscribe function.
  ide.onEditor = (fn) => {
    editorHooks.add(fn);
    for (const g of groups) safe(() => fn(g.editor));
    return () => editorHooks.delete(fn);
  };
  // Options that apply to every editor, current and future (font, wrapping, rulers...).
  ide.updateEditorOptions = ({ theme, ...opts }) => {
    if (theme) ide.monaco.editor.setTheme(theme);
    editorOptions = { ...editorOptions, ...opts };
    for (const g of groups) g.editor.updateOptions(opts);
    for (const ed of embedded) ed.updateOptions(opts);
  };
  ide.editorOptions = () => ({ ...editorOptions });
  // An extra Monaco editor (inside a viewer) that behaves like a group editor for plugins.
  ide.createEditor = (host, opts = {}) => {
    const ed = ide.monaco.editor.create(host, { ...editorOptions, ...opts });
    embedded.add(ed);
    ed.onDidDispose(() => embedded.delete(ed));
    for (const fn of editorHooks) safe(() => fn(ed));
    ide.emit('editorCreated', ed);
    return ed;
  };

  ide.findTab = (path) => {
    if (!path) return null;
    const ordered = activeGroup ? [activeGroup, ...groups.filter((g) => g !== activeGroup)] : groups;
    for (const g of ordered) for (const t of g.tabs) if (samePath(t.path, path)) return t;
    return null;
  };
  ide.activeTab = () => activeGroup?.active || null;
  ide.isDirty = (t) => !!t?.doc && docDirty(t.doc);
  ide.getDocument = (path) => docs.get(key(path)) || null;

  function resolveGroup(target) {
    if (target && typeof target === 'object') return groups.includes(target) ? target : activeGroup;
    if (target === 'right' || target === 'down') {
      const other = oppositeGroup(activeGroup);
      return other && target === 'right' ? other : splitGroup(activeGroup, target, null);
    }
    return activeGroup;
  }

  // File viewers take over files a text editor cannot show (images, media, arrays) or add a richer view.
  // {id, title, icon, match(path) -> bool, binaryOnly?: true, text?: true, mount(host, {path, doc, tab}) -> {dispose?}}
  ide.registerFileViewer = (viewer) => { viewers.push(viewer); };
  const viewerFor = (path, { binary = false } = {}) => viewers.find((v) => v.match(path) && (!v.binaryOnly || binary)) || null;

  // opts: {line, col, focus = true, group: 'active'|'right'|'down'|'window'|group, preview, asText, text}
  ide.openFile = async (path, opts = {}) => {
    if (opts.group === 'window') { await openInNewWindow([{ path, line: opts.line }]); return null; }
    let viewer = opts.asText ? null : viewerFor(path);
    let doc = null;
    if (!viewer || viewer.text) {
      doc = await loadDoc(path).catch((e) => ({ error: e }));
      if (doc.error) {
        alert(tr('Cannot open {name}: {error}', { name: basename(path), error: String(doc.error.message || doc.error).replace(/^Error invoking remote method '[^']+': (Error: )?/, '') }));
        return null;
      }
      if (doc.unsupported) {
        viewer = viewerFor(path, { binary: true }) || binaryViewer;
        doc = null;
      }
    }
    const g = resolveGroup(opts.group);
    // A viewer (also one that edits text, like Markdown) is found by path and viewer; a plain editor by its document.
    let tab = g.tabs.find((t) => (viewer ? samePath(t.path, path) && t.kind === 'custom' && t.viewer === viewer : t.doc === doc && t.kind === 'file'));
    if (!tab && viewer) tab = openViewerTab(g, path, viewer, doc);
    else if (!tab) {
      const preview = opts.preview && settingOn('editor.previewTab', false);
      const old = preview ? g.tabs.find((t) => t.preview && !ide.isDirty(t)) : null;
      tab = makeFileTab(doc, g);
      tab.preview = !!preview;
      addTab(g, tab, old ? g.tabs.indexOf(old) + 1 : undefined);
      if (old) closeTabObj(old, true);
    } else if (!opts.preview && tab.preview) tab.preview = false;
    if (doc?.fresh) { delete doc.fresh; ide.emit('fileOpened', tab); }
    setActiveGroup(g);
    activateTab(g, tab);
    if (opts.text !== undefined && doc && doc.model.getValue() !== opts.text) applyRemoteText(doc, opts.text);
    if (opts.line && tab.kind === 'file') {
      const pos = { lineNumber: opts.line, column: opts.col || 1 };
      g.editor.setPosition(pos);
      g.editor.revealPositionInCenterIfOutsideViewport(pos);
    }
    if (opts.focus !== false) focusGroup(g);
    return tab;
  };

  function openViewerTab(g, path, viewer, doc) {
    const host = el('div', 'custom-tab hidden');
    host.tabIndex = -1;
    g.customHost.appendChild(host);
    const tab = { kind: 'custom', group: g, path, title: basename(path), icon: viewer.icon || '◆', host, viewer, doc, model: doc?.model, pinned: false };
    addTab(g, tab);
    const r = safeMount(() => viewer.mount(host, { path, doc, tab }));
    tab.dispose = () => r?.dispose?.();
    return tab;
  }
  const safeMount = (fn) => { try { return fn(); } catch (err) { console.error(err); return null; } };

  const binaryViewer = {
    id: 'binary', icon: '📦', match: () => false,
    mount(host, { path }) {
      host.classList.add('binary-viewer');
      host.appendChild(el('div', 'binary-title', basename(path)));
      host.appendChild(el('div', 'muted', tr('This file is binary or too large to show as text.')));
      const row = el('div', 'binary-actions');
      const open = el('button', 'secondary', tr('Open with Default App'));
      open.onclick = () => ide.api.invoke('shell:openPath', path);
      const reveal = el('button', 'secondary', tr('Show in Explorer'));
      reveal.onclick = () => ide.api.invoke('shell:showInFolder', path);
      row.append(open, reveal);
      host.appendChild(row);
    },
  };

  // {id, title, icon?, mount(host, tab), onClose?()} -> tab; reopening an existing id just activates it.
  ide.openCustomTab = ({ id, title, icon = '◆', mount, onClose, group }) => {
    let tab = ide.findTab(id);
    if (!tab) {
      const g = resolveGroup(group);
      const host = el('div', 'custom-tab hidden');
      g.customHost.appendChild(host);
      tab = { kind: 'custom', group: g, path: id, title, icon, host, onClose, pinned: false };
      addTab(g, tab);
      mount(host, tab);
    }
    setActiveGroup(tab.group);
    activateTab(tab.group, tab);
    return tab;
  };

  ide.renderTabs = renderAllTabs;

  // Closes the tab for `path` in the active group (or wherever it is open).
  ide.closeTab = (path, force) => {
    const tab = ide.findTab(path);
    return tab ? closeTabObj(tab, force) : true;
  };
  ide.closeTabObject = closeTabObj;
  ide.closeAllTabs = (force) => {
    for (const g of [...groups]) for (const t of [...g.tabs]) if (!closeTabObj(t, force)) return false;
    return true;
  };

  // ---------- saving ----------
  // Save actions rewrite the text before it is written, on explicit and auto saves alike: {id, order, run(text, ctx) ->
  // new text | undefined}, ctx = {doc, path, auto, eol, modifiedLines, caretLines} (Sets of 1-based line numbers).
  // They run in order on the text, and the result lands in the model as one undo step of line-level edits.
  const saveActions = [];
  ide.registerSaveAction = (a) => { saveActions.push(a); saveActions.sort((x, y) => (x.order ?? 50) - (y.order ?? 50)); };

  const editorsOf = (model) => [...groups.map((g) => g.editor), ...embedded].filter((ed) => ed.getModel() === model);

  // Returns false when the text changed while the actions ran (their result is then dropped).
  async function runSaveActions(doc, auto) {
    const model = doc.model;
    const version = model.getVersionId();
    const before = model.getValue();
    const caretLines = new Set(editorsOf(model).flatMap((ed) => ed.getSelections().map((s) => s.positionLineNumber)));
    const ctx = { doc, path: doc.path, auto, eol: model.getEOL(), modifiedLines: changedLines(doc), caretLines };
    let text = before;
    for (const a of saveActions) {
      try {
        const out = await a.run(text, ctx);
        if (typeof out === 'string') text = out;
      } catch (err) { ide.log.warn(`save action ${a.id} failed: ${err?.message || err}`); }
      if (model.isDisposed() || model.getVersionId() !== version) return false;
    }
    if (text !== before) {
      const ed = editorsOf(model).find((e) => e.hasTextFocus()) || editorsOf(model)[0];
      model.pushStackElement();
      model.pushEditOperations(ed?.getSelections() || null, lineEdits(model, text), () => null);
      model.pushStackElement();
    }
    return true;
  }

  // Minimal whole-line edits turning the model's text into `text`, so carets outside changed lines stay put.
  function lineEdits(model, text) {
    const eol = model.getEOL();
    const a = model.getLinesContent();
    const b = text.split(/\r\n|\n/);
    const { Range } = ide.monaco;
    return diffLines(a, b).map(([s, e, t, u]) => {
      const lines = b.slice(t, u);
      if (e < a.length) return { range: new Range(s + 1, 1, e + 1, 1), text: lines.map((l) => l + eol).join('') };
      if (s > 0) return { range: new Range(s, model.getLineMaxColumn(s), a.length, model.getLineMaxColumn(a.length)), text: lines.map((l) => eol + l).join('') };
      return { range: model.getFullModelRange(), text: lines.join(eol) };
    });
  }

  // Myers line diff -> hunks [aStart, aEnd, bStart, bEnd]; one hunk for the whole middle when the diff is too large.
  function diffLines(a, b) {
    let pre = 0;
    while (pre < a.length && pre < b.length && a[pre] === b[pre]) pre++;
    let suf = 0;
    while (suf < a.length - pre && suf < b.length - pre && a[a.length - 1 - suf] === b[b.length - 1 - suf]) suf++;
    const n = a.length - pre - suf;
    const m = b.length - pre - suf;
    if (!n && !m) return [];
    const max = n + m;
    const off = max + 1;
    const v = new Int32Array(2 * max + 2);
    const trace = [];
    let found = false;
    for (let d = 0; d <= max && !found; d++) {
      if ((d + 1) * v.length > 4e6) return [[pre, pre + n, pre, pre + m]];
      trace.push(v.slice());
      for (let k = -d; k <= d; k += 2) {
        let x = k === -d || (k !== d && v[off + k - 1] < v[off + k + 1]) ? v[off + k + 1] : v[off + k - 1] + 1;
        let y = x - k;
        while (x < n && y < m && a[pre + x] === b[pre + y]) { x++; y++; }
        v[off + k] = x;
        if (x >= n && y >= m) { found = true; break; }
      }
    }
    const matches = [];
    let x = n;
    let y = m;
    for (let d = trace.length - 1; d >= 0; d--) {
      const w = trace[d];
      const k = x - y;
      const pk = k === -d || (k !== d && w[off + k - 1] < w[off + k + 1]) ? k + 1 : k - 1;
      const px = d ? w[off + pk] : 0;
      const py = d ? px - pk : 0;
      while (x > px && y > py) { x--; y--; matches.push([x, y]); }
      x = px;
      y = py;
    }
    matches.reverse();
    const hunks = [];
    let i = 0;
    let j = 0;
    for (const [mx, my] of [...matches, [n, m]]) {
      if (mx > i || my > j) hunks.push([pre + i, pre + mx, pre + j, pre + my]);
      i = mx + 1;
      j = my + 1;
    }
    return hunks;
  }

  // Auto save leaves alone what nobody would expect it to write: untitled documents, read-only ones, documents shown
  // only in a viewer, files whose disk text changed since PyIDE read or wrote them, files it cannot read (a deleted
  // file, an unreachable network or remote path), and a version whose auto save already failed.
  async function autoSavable(doc) {
    if (doc.untitled || doc.readOnly || doc.model.uri.scheme !== 'file') return false;
    if (!tabsOfDoc(doc).some((t) => t.kind === 'file')) return false;
    if (doc.autoSaveFailed === doc.model.getAlternativeVersionId()) return false;
    let r = null;
    try { r = await ide.api.invoke('fs:readText', doc.path); } catch {}
    if (r?.text !== undefined && textHash(r.text) === doc.diskHash) return true;
    if (!doc.conflict) { doc.conflict = true; ide.emit('autoSaveSkipped', { path: doc.path, reason: r ? 'changedOnDisk' : 'unreadable' }); }
    return false;
  }

  async function saveDoc(doc, { auto = false } = {}) {
    while (doc.saving) await doc.saving;
    if (!docDirty(doc) || doc.model.isDisposed()) return;
    if (auto && !(await autoSavable(doc))) return;
    let done;
    doc.saving = new Promise((r) => { done = r; });
    try { await writeDoc(doc, auto); } finally { doc.saving = null; done(); }
  }

  async function writeDoc(doc, auto) {
    const tab = firstTabFor(doc) || { kind: 'file', path: doc.path, model: doc.model, doc };
    ide.emit('beforeSave', tab);
    if (!(await runSaveActions(doc, auto)) && auto) return;
    if (doc.model.isDisposed()) return;
    // The version written, not the one after the write: edits typed while it runs are not on disk yet.
    const text = doc.model.getValue();
    const version = doc.model.getAlternativeVersionId();
    try {
      await ide.api.invoke('fs:writeText', doc.path, text, doc.encoding);
    } catch (e) {
      const error = String(e.message || e).replace(/^Error invoking remote method '[^']+': (Error: )?/, '');
      if (!auto) alert(tr('Could not save {name}: {error}', { name: basename(doc.path), error }));
      else {
        doc.autoSaveFailed = version;
        ide.emit('autoSaveSkipped', { path: doc.path, reason: 'failed', error });
      }
      return;
    }
    doc.savedVersion = version;
    doc.diskHash = textHash(text);
    doc.conflict = false;
    if (!docDirty(doc)) clearChanged(doc);
    if (peers > 1) ide.api.send('doc:saved', { path: doc.path, text });
    for (const t of tabsOfDoc(doc)) t.preview = false;
    ide.emit('fileSaved', tab);
  }
  ide.saveTab = async (tab) => { if (tab?.doc) await saveDoc(tab.doc); renderAllTabs(); };
  ide.saveAll = async () => {
    await Promise.all([...docs.values()].map((d) => saveDoc(d)));
    renderAllTabs();
  };
  // Saves modified documents (all, or those at `paths`) the way auto save does; see autoSavable.
  ide.autoSave = async (paths) => {
    const list = [...docs.values()].filter((d) => docDirty(d) && (!paths || paths.some((p) => samePath(p, d.path))));
    await Promise.all(list.map((d) => saveDoc(d, { auto: true })));
    if (list.length) renderAllTabs();
  };

  // Reloads open documents whose file changed on disk (after formatters, git checkout, replace-in-files...).
  ide.reloadFromDisk = async (paths) => {
    for (const doc of [...docs.values()].filter((d) => !paths || paths.some((p) => samePath(p, d.path)))) {
      if (docDirty(doc)) continue;
      let r;
      try { r = await ide.api.invoke('fs:readText', doc.path, doc.encoding); } catch { continue; }
      // Typed into or closed while the file was read: the editor's text wins.
      if (doc.model.isDisposed() || docDirty(doc)) continue;
      if (r.text === undefined || r.text === doc.model.getValue()) continue;
      doc.model.pushEditOperations([], [{ range: doc.model.getFullModelRange(), text: r.text }], () => null);
      doc.savedVersion = doc.model.getAlternativeVersionId();
      Object.assign(doc, { diskHash: textHash(r.text), conflict: false });
      clearChanged(doc);
    }
    renderAllTabs();
  };

  // ---------- status bar: encoding ----------
  const ENCODING_LABEL = { 'utf-8': 'UTF-8', 'utf-8-bom': 'UTF-8 BOM', 'utf-16le': 'UTF-16 LE', 'utf-16be': 'UTF-16 BE', cp949: 'CP949 (EUC-KR)' };
  const encodingItem = el('span', 'status-encoding');
  encodingItem.id = 'statusEncoding';
  encodingItem.title = tr('File encoding');
  $('statusEncodingSlot').replaceWith(encodingItem);
  function updateStatus() {
    const t = activeGroup?.active;
    $('statusPath').textContent = !t ? '' : t.kind === 'file' || t.doc || t.viewer ? ide.util.rel(t.path) : t.title;
    encodingItem.textContent = t?.doc ? ENCODING_LABEL[t.doc.encoding] || t.doc.encoding : '';
    const pos = t?.kind === 'file' ? activeGroup.editor.getPosition() : null;
    $('statusPos').textContent = pos ? `${pos.lineNumber}:${pos.column}` : '';
    if (ide.detached) ide.api.invoke('window:setTitle', t ? `${t.title} - PyIDE` : 'PyIDE');
  }
  encodingItem.onclick = () => {
    const doc = ide.activeTab()?.doc;
    if (!doc) return;
    const r = encodingItem.getBoundingClientRect();
    ide.ui.contextMenu(r.left, r.top - 8, [
      ...Object.entries(ENCODING_LABEL).map(([enc, label]) => ({
        label: tr('Reload in {encoding}', { encoding: label }), hint: enc === doc.encoding ? '✓' : '', disabled: docDirty(doc),
        run: async () => {
          const res = await ide.api.invoke('fs:decode', doc.path, enc);
          doc.encoding = enc;
          doc.model.pushEditOperations([], [{ range: doc.model.getFullModelRange(), text: res.text }], () => null);
          doc.savedVersion = doc.model.getAlternativeVersionId();
          doc.diskHash = textHash(res.text);
          clearChanged(doc);
          renderAllTabs();
          updateStatus();
        },
      })),
      { separator: true },
      ...Object.entries(ENCODING_LABEL).filter(([enc]) => enc !== doc.encoding).map(([enc, label]) => ({
        label: tr('Convert to {encoding}', { encoding: label }),
        run: async () => {
          const prev = doc.encoding;
          doc.encoding = enc;
          try { await ide.api.invoke('fs:writeText', doc.path, doc.model.getValue(), enc); } catch (e) {
            doc.encoding = prev;
            alert(String(e.message || e).replace(/^Error invoking remote method '[^']+': (Error: )?/, ''));
            return;
          }
          doc.savedVersion = doc.model.getAlternativeVersionId();
          renderAllTabs();
          updateStatus();
        },
      })),
    ]);
  };

  // ---------- menus ----------
  const fileTabs = (g) => g.tabs;
  function closeMany(list) { for (const t of list) if (!closeTabObj(t)) break; }

  function showTabMenu(t, x, y) {
    const g = t.group;
    const i = g.tabs.indexOf(t);
    const other = oppositeGroup(g);
    const isFile = t.kind === 'file' || !!t.doc || !!t.viewer;
    ide.ui.contextMenu(x, y, [
      { label: tr('Close'), hint: 'Ctrl+F4', run: () => closeTabObj(t) },
      { label: tr('Close Other Tabs'), run: () => closeMany(fileTabs(g).filter((o) => o !== t && !o.pinned)) },
      { label: tr('Close All Tabs'), run: () => closeMany(fileTabs(g).filter((o) => !o.pinned)) },
      { label: tr('Close Tabs to the Left'), disabled: i === 0, run: () => closeMany(g.tabs.slice(0, i).filter((o) => !o.pinned)) },
      { label: tr('Close Tabs to the Right'), disabled: i === g.tabs.length - 1, run: () => closeMany(g.tabs.slice(i + 1).filter((o) => !o.pinned)) },
      { label: tr('Close Unmodified Tabs'), run: () => closeMany(g.tabs.filter((o) => !ide.isDirty(o) && !o.pinned)) },
      { separator: true },
      { label: t.pinned ? tr('Unpin Tab') : tr('Pin Tab'), run: () => togglePin(t) },
      { separator: true },
      { label: tr('Split Right'), hint: 'Ctrl+\\', run: () => splitGroup(g, 'right', t, { clone: true }) },
      { label: tr('Split Down'), hint: 'Ctrl+Shift+\\', run: () => splitGroup(g, 'down', t, { clone: true }) },
      { label: tr('Split and Move Right'), disabled: g.tabs.length < 2, run: () => splitGroup(g, 'right', t, { clone: false }) },
      { label: tr('Split and Move Down'), disabled: g.tabs.length < 2, run: () => splitGroup(g, 'down', t, { clone: false }) },
      { label: tr('Move to Opposite Group'), disabled: !other, run: () => placeTab(t, other, { clone: false }) },
      { label: tr('Open in New Window'), hint: 'Shift+F4', disabled: !isFile, run: () => openInNewWindow([tabPayload(t)]) },
      { label: tr('Move to New Window'), disabled: !isFile, run: () => moveToNewWindow(t) },
      ...(ide.detached ? [{ label: tr('Move to Main Window'), run: () => dockToMain([t]) }] : []),
      ...(t.viewer && t.viewer.id !== 'binary' ? [{ label: tr('Open as Text'), run: () => ide.openFile(t.path, { asText: true, group: g }) }] : []),
      { separator: true },
      { label: tr('Copy Path'), hint: 'Ctrl+Shift+C', disabled: !isFile, run: () => copyPath(t.path) },
      { label: tr('Copy Relative Path'), disabled: !isFile, run: () => copyPath(ide.util.rel(t.path)) },
      { label: tr('Select in Project View'), hint: 'Alt+F1', disabled: !isFile || ide.detached, run: () => selectInProject(t.path) },
      { label: tr('Show in Explorer'), disabled: !isFile, run: () => ide.api.invoke('shell:showInFolder', t.path) },
      { label: tr('Open with Default App'), disabled: !isFile, run: () => ide.api.invoke('shell:openPath', t.path) },
    ]);
  }

  function showGroupMenu(g, x, y) {
    setActiveGroup(g);
    ide.ui.contextMenu(x, y, [
      { label: tr('Split Right'), hint: 'Ctrl+\\', run: () => splitGroup(g, 'right', g.active, { clone: true }) },
      { label: tr('Split Down'), hint: 'Ctrl+Shift+\\', run: () => splitGroup(g, 'down', g.active, { clone: true }) },
      { label: tr('Unsplit'), disabled: groups.length < 2, run: () => unsplit(g) },
      { label: tr('Unsplit All'), disabled: groups.length < 2, run: unsplitAll },
      { label: tr('Change Splitter Orientation'), disabled: groups.length < 2, run: () => flipOrientation(g) },
      { separator: true },
      { label: tr('Close All Tabs'), run: () => closeMany(g.tabs.filter((o) => !o.pinned)) },
      { label: tr('Reopen Closed Tab'), hint: 'Ctrl+Shift+T', disabled: !closedTabs.length, run: reopenClosed },
    ]);
  }

  function togglePin(t) {
    t.pinned = !t.pinned;
    t.preview = false;
    const g = t.group;
    g.tabs.splice(g.tabs.indexOf(t), 1);
    const pinnedCount = g.tabs.filter((o) => o.pinned).length;
    g.tabs.splice(t.pinned ? pinnedCount : pinnedCount, 0, t);
    renderTabs(g);
  }

  // Unsplit merges a group's tabs into its neighbour.
  function unsplit(g) {
    const other = oppositeGroup(g);
    if (!other) return;
    for (const t of [...g.tabs]) placeTab(t, other, { clone: false });
  }

  function flipOrientation(g) {
    const leaf = leafOf(layout, g);
    const { parent } = findParent(layout, leaf) || {};
    if (!parent) return;
    parent.dir = parent.dir === 'row' ? 'column' : 'row';
    renderLayout();
  }

  async function reopenClosed() {
    const last = closedTabs.pop();
    if (!last || last.kind === 'custom' && !last.viewer) return;
    await ide.openFile(last.path);
  }

  const copyPath = (text) => ide.api.invoke('clipboard:writeText', text);

  async function selectInProject(path) {
    if (!ide.root || !isUnder(path, ide.root)) return;
    ide.toolWindows.get('Project')?.show();
    await ide.revealInTree(path);
  }

  function cycleTab(dir) {
    const g = activeGroup;
    if (!g?.tabs.length) return;
    const i = g.tabs.indexOf(g.active);
    activateTab(g, g.tabs[(i + dir + g.tabs.length) % g.tabs.length], { focus: true });
  }

  function focusGroupAt(n) {
    const ordered = [];
    const walk = (node) => (node.kind === 'leaf' ? ordered.push(node.group) : (walk(node.a), walk(node.b)));
    walk(layout);
    const g = ordered[n];
    if (g) { setActiveGroup(g); focusGroup(g); }
  }

  // Tool windows hidden by "Hide All Tool Windows" come back on the next toggle.
  let hiddenToolWindows = null;
  function toggleMaximizeEditor() {
    if (hiddenToolWindows) {
      for (const tw of hiddenToolWindows) tw.show();
      hiddenToolWindows = null;
      focusGroup(activeGroup);
      return;
    }
    hiddenToolWindows = [...ide.toolWindows.values()].filter((tw) => tw.isVisible());
    for (const tw of hiddenToolWindows) tw.hide();
    focusGroup(activeGroup);
  }

  // ---------- detached windows ----------
  const tabPayload = (t) => {
    const pos = t.kind === 'file' && t.group.active === t ? t.group.editor.getPosition() : null;
    return { path: t.path, line: pos?.lineNumber, col: pos?.column, text: t.doc && docDirty(t.doc) ? t.doc.model.getValue() : undefined, asText: t.kind === 'file' && !!viewerFor(t.path) };
  };
  const openInNewWindow = (files) => ide.api.invoke('window:openDetached', { files });
  async function moveToNewWindow(t) {
    const payload = tabPayload(t);
    await openInNewWindow([payload]);
    // The new window now holds any unsaved text; drop this copy without asking.
    closeTabObj(t, true);
  }
  async function dockToMain(tabs) {
    const files = tabs.map(tabPayload);
    if (await ide.api.invoke('window:dockToMain', { files })) for (const t of tabs) closeTabObj(t, true);
  }
  ide.api.on('window:dock', async ({ files }) => {
    for (const f of files) await ide.openFile(f.path, { line: f.line, col: f.col, text: f.text, asText: f.asText });
  });

  // A window with unsaved documents asks before it closes (the main process holds the close until then).
  ide.api.on('window:confirmClose', () => {
    const dirtyDocs = [...docs.values()].filter(docDirty);
    if (!dirtyDocs.length) { ide.api.invoke('window:closeNow'); return; }
    const list = el('ul', 'close-confirm-list');
    for (const d of dirtyDocs) list.appendChild(el('li', null, ide.util.rel(d.path)));
    const body = el('div');
    body.append(el('div', null, tr('These files have unsaved changes:')), list);
    ide.ui.dialog({
      title: tr('Save Changes?'),
      body,
      width: 460,
      buttons: [
        // A file that could not be saved (its error was shown) keeps the window open.
        { label: tr('Save All'), primary: true, run: async () => { await ide.saveAll(); if (![...docs.values()].some(docDirty)) ide.api.invoke('window:closeNow'); } },
        { label: tr("Don't Save"), run: () => { ide.api.send('window:setDirty', false); ide.api.invoke('window:closeNow'); } },
        { label: tr('Cancel') },
      ],
    });
  });

  // ---------- actions ----------
  const inGroup = () => !!activeGroup;
  [
    { id: 'CloseContent', title: tr('Close Tab'), keys: 'Ctrl+F4', run: () => activeGroup?.active && closeTabObj(activeGroup.active) },
    { id: 'PreviousTab', title: tr('Previous Tab'), keys: 'Alt+ArrowLeft', run: () => cycleTab(-1) },
    { id: 'NextTab', title: tr('Next Tab'), keys: 'Alt+ArrowRight', run: () => cycleTab(1) },
    { id: 'Switcher', title: tr('Switch to Previous Tab'), keys: 'Ctrl+Tab', run: () => { const t = mru[1]; if (t) { setActiveGroup(t.group); activateTab(t.group, t, { focus: true }); } } },
    { id: 'SplitVertically', title: tr('Split Right'), keys: 'Ctrl+\\', when: inGroup, run: () => splitGroup(activeGroup, 'right', activeGroup.active, { clone: true }) },
    { id: 'SplitHorizontally', title: tr('Split Down'), keys: 'Ctrl+Shift+\\', when: inGroup, run: () => splitGroup(activeGroup, 'down', activeGroup.active, { clone: true }) },
    { id: 'SplitAndMoveRight', title: tr('Split and Move Right'), run: () => activeGroup.tabs.length > 1 && splitGroup(activeGroup, 'right', activeGroup.active, { clone: false }) },
    { id: 'SplitAndMoveDown', title: tr('Split and Move Down'), run: () => activeGroup.tabs.length > 1 && splitGroup(activeGroup, 'down', activeGroup.active, { clone: false }) },
    { id: 'MoveEditorToOppositeTabGroup', title: tr('Move to Opposite Group'), run: () => { const o = oppositeGroup(activeGroup); if (o && activeGroup.active) placeTab(activeGroup.active, o, { clone: false }); } },
    { id: 'Unsplit', title: tr('Unsplit'), run: () => unsplit(activeGroup) },
    { id: 'UnsplitAll', title: tr('Unsplit All'), run: unsplitAll },
    { id: 'ChangeSplitOrientation', title: tr('Change Splitter Orientation'), run: () => flipOrientation(activeGroup) },
    { id: 'NextSplitter', title: tr('Go to Next Splitter'), keys: 'Ctrl+Alt+]', run: () => { const o = oppositeGroup(activeGroup); if (o) { setActiveGroup(o); focusGroup(o); } } },
    { id: 'FocusGroup1', title: tr('Focus Editor Group {n}', { n: 1 }), keys: 'Ctrl+1', run: () => focusGroupAt(0) },
    { id: 'FocusGroup2', title: tr('Focus Editor Group {n}', { n: 2 }), keys: 'Ctrl+2', run: () => focusGroupAt(1) },
    { id: 'FocusGroup3', title: tr('Focus Editor Group {n}', { n: 3 }), keys: 'Ctrl+3', run: () => focusGroupAt(2) },
    { id: 'PinActiveTab', title: tr('Pin Tab'), run: () => activeGroup?.active && togglePin(activeGroup.active) },
    { id: 'ReopenClosedTab', title: tr('Reopen Closed Tab'), keys: 'Ctrl+Shift+T', run: reopenClosed },
    { id: 'OpenInNewWindow', title: tr('Open in New Window'), keys: 'Shift+F4', run: () => activeGroup?.active && openInNewWindow([tabPayload(activeGroup.active)]) },
    { id: 'MoveToNewWindow', title: tr('Move to New Window'), run: () => activeGroup?.active && moveToNewWindow(activeGroup.active) },
    { id: 'CopyPaths', title: tr('Copy Path'), keys: 'Ctrl+Shift+C', run: () => activeGroup?.active && copyPath(activeGroup.active.path) },
    { id: 'SelectInProjectView', title: tr('Select in Project View'), keys: 'Alt+F1', run: () => activeGroup?.active && selectInProject(activeGroup.active.path) },
    { id: 'ShowInExplorer', title: tr('Show in Explorer'), run: () => activeGroup?.active && ide.api.invoke('shell:showInFolder', activeGroup.active.path) },
    { id: 'OpenFile', title: tr('Open File…'), run: async () => { const p = await ide.api.openFileDialog(); if (p) ide.openFile(p); } },
    { id: 'HideAllWindows', title: tr('Hide All Tool Windows'), keys: 'Ctrl+Shift+F12', run: toggleMaximizeEditor, terminal: true },
  ].forEach(ide.registerAction);

  // ---------- boot ----------
  ide.initEditors = (options) => {
    // Monaco's theme is global: passing it to each new editor would reset the current theme (e.g. Light) to the startup one.
    const { theme, ...rest } = options;
    editorOptions = rest;
    if (theme) ide.monaco.editor.setTheme(theme);
    const g = createGroup();
    layout = { kind: 'leaf', group: g };
    renderLayout();
    activeGroup = null;
    setActiveGroup(g);
    activateTab(g, null);
  };

  // Detached windows show only the editor area and open the files they were given.
  ide.initDetachedWindow = async () => {
    const state = await ide.api.invoke('window:initialState');
    for (const f of state?.files || []) {
      await ide.openFile(f.path, { line: f.line, col: f.col, text: f.text, asText: f.asText });
    }
  };
})();
