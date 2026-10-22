// Breadcrumbs above each editor and the Call Hierarchy tool window (Ctrl+Alt+H), both from Pyright through ide.lsp.
(() => {
  const { el, basename, dirname, joinPath, samePath, isUnder } = ide.util;
  const SETTING = 'editor.breadcrumbs';
  const shown = () => ide.settings.get(SETTING, true) !== false;
  const CURSOR_DEBOUNCE = 120;
  const EDIT_DEBOUNCE = 400;

  // file:///c%3A/x.py -> C:\x.py; file://server/share/x.py (UNC) -> \\server\share\x.py
  const toPath = (uri) => decodeURIComponent(String(uri).replace(/^file:\/\/\//i, '').replace(/^file:\/\//i, '//'))
    .replace(/\//g, '\\').replace(/^([a-z]):/, (_m, d) => `${d.toUpperCase()}:`);
  const modelPath = (model) => (model?.uri.scheme === 'file' ? toPath(model.uri.toString()) : null);
  const isPy = (p) => /\.pyi?$/i.test(p || '');
  // Names, paths and code are data, not UI text (verify/i18n-lib.mjs skips them).
  const userText = (node) => ((node.dataset.userText = ''), node);
  const contains = (r, pos) => {
    const l = pos.lineNumber - 1;
    const c = pos.column - 1;
    if (l < r.start.line || l > r.end.line) return false;
    if (l === r.start.line && c < r.start.character) return false;
    return !(l === r.end.line && c > r.end.character);
  };

  // LSP SymbolKind -> [css kind, letter], as in the Structure tool window.
  const KINDS = { 5: ['class', 'C'], 6: ['method', 'm'], 7: ['property', 'p'], 8: ['field', 'f'], 9: ['method', 'm'],
    12: ['function', 'f'], 13: ['variable', 'v'], 14: ['variable', 'v'] };
  const kindIcon = (kind) => { const [c, l] = KINDS[kind] || ['other', '•']; return el('span', `nb-icon k-${c}`, l); };
  // Only scopes nest in the breadcrumbs: classes, functions, methods and properties.
  const SCOPES = new Set([5, 6, 7, 9, 12]);
  const scopes = (list) => (list || []).filter((s) => SCOPES.has(s.kind) && s.range);

  // ---------- document symbols, one request per model version ----------
  const symbolCache = new WeakMap(); // model -> {version, promise, empty}
  function symbolsOf(model) {
    const path = modelPath(model);
    if (!isPy(path)) return Promise.resolve([]);
    const version = model.getVersionId();
    const cached = symbolCache.get(model);
    if (cached?.version === version) return cached.promise;
    const entry = { version, empty: false };
    entry.promise = ide.lsp.documentSymbols(path).catch(() => []).then((list) => { entry.empty = !list.length; return list; });
    symbolCache.set(model, entry);
    return entry.promise;
  }

  // The scopes containing the caret, outermost first, each with the scopes beside it.
  function chainAt(symbols, pos) {
    const chain = [];
    for (let level = scopes(symbols); ;) {
      const hit = level.find((s) => contains(s.range, pos));
      if (!hit) return chain;
      chain.push({ sym: hit, siblings: level });
      level = scopes(hit.children);
    }
  }

  // Path segments relative to the project (the file alone outside it), each with the folder that lists its siblings.
  function pathSegments(path) {
    if (!ide.root || !isUnder(path, ide.root) || samePath(path, ide.root)) return [{ name: basename(path), path, parent: dirname(path) }];
    let dir = ide.root;
    return ide.util.rel(path).split(/[\\/]/).filter(Boolean).map((name) => {
      const seg = { name, path: joinPath(dir, name), parent: dir };
      dir = seg.path;
      return seg;
    });
  }

  // ide.ui.contextMenu with element icons (file icons, symbol kinds) and the current entry marked.
  function openMenu(anchor, items) {
    const r = anchor.getBoundingClientRect();
    const menu = ide.ui.contextMenu(r.left, r.bottom + 2, items);
    menu.classList.add('nb-menu');
    const rows = menu.querySelectorAll('.menu-item');
    items.forEach((it, i) => {
      if (it.iconEl) rows[i]?.querySelector('.menu-icon').replaceChildren(it.iconEl);
      if (it.current) rows[i]?.classList.add('nb-current');
    });
    return menu;
  }

  async function folderMenu(anchor, dir, currentPath) {
    const entries = await ide.api.list(dir).catch(() => []);
    if (!entries.length) return openMenu(anchor, [{ label: tr('Empty folder'), disabled: true }]);
    openMenu(anchor, entries.map((e) => ({
      label: e.name, userText: true, iconEl: ide.fileIcon(e.path, { dir: e.dir }), current: samePath(e.path, currentPath),
      run: () => (e.dir ? folderMenu(anchor, e.path, null) : ide.openFile(e.path)),
    })));
  }

  function jumpTo(ed, sym) {
    const pos = { lineNumber: sym.line, column: sym.col };
    ed.setPosition(pos);
    ed.revealPositionInCenterIfOutsideViewport(pos);
    ed.focus();
  }

  // ---------- breadcrumbs bar, one per editor group ----------
  const bars = new Map(); // editor -> {ed, bar, timer, seq, key}

  function render(state, path, chain) {
    const { ed, bar } = state;
    const parts = [];
    const segs = pathSegments(path);
    segs.forEach((seg, i) => {
      const isFile = i === segs.length - 1;
      const crumb = el('span', 'nb-crumb');
      crumb.dataset.kind = 'path';
      crumb.append(ide.fileIcon(seg.path, { dir: !isFile }), userText(el('span', 'nb-name', seg.name)));
      crumb.onclick = () => folderMenu(crumb, seg.parent, seg.path);
      parts.push(crumb);
    });
    for (const { sym, siblings } of chain) {
      const crumb = el('span', 'nb-crumb');
      crumb.dataset.kind = 'symbol';
      crumb.dataset.name = sym.name;
      const name = userText(el('span', 'nb-name', sym.name));
      name.onclick = () => jumpTo(ed, sym);
      const drop = el('span', 'nb-drop', '▾');
      drop.title = tr('Show Siblings');
      drop.onclick = () => openMenu(crumb, siblings.map((s) => ({
        label: s.name, userText: true, iconEl: kindIcon(s.kind), current: s === sym, run: () => jumpTo(ed, s),
      })));
      crumb.append(kindIcon(sym.kind), name, drop);
      parts.push(crumb);
    }
    const nodes = [];
    parts.forEach((p, i) => { if (i) nodes.push(el('span', 'nb-crumb-sep', '›')); nodes.push(p); });
    bar.replaceChildren(...nodes);
    // Long paths keep the innermost crumbs in view; the bar's height never changes.
    bar.scrollLeft = bar.scrollWidth;
  }

  async function update(state) {
    const { ed, bar } = state;
    const seq = ++state.seq;
    const model = ed.getModel();
    const path = modelPath(model);
    const visible = shown() && !!path;
    bar.classList.toggle('hidden', !visible);
    if (!visible) { state.key = ''; return; }
    // Another file: its path at once. The symbols wait for Pyright, which may be busy (Find Usages) for seconds,
    // and until then the bar named the file shown before (main.py › main above shapes.py).
    if (!state.key.startsWith(`${path}|`)) { state.key = `${path}|`; render(state, path, []); }
    const symbols = await symbolsOf(model);
    if (seq !== state.seq || ed.getModel() !== model) return;
    const pos = ed.getPosition();
    const chain = pos ? chainAt(symbols, pos) : [];
    const key = `${path}|${chain.map((c) => `${c.sym.name}:${c.sym.line}:${c.siblings.length}`).join('/')}`;
    if (key === state.key) return;
    state.key = key;
    render(state, path, chain);
  }

  const schedule = (state, ms) => {
    clearTimeout(state.timer);
    state.timer = setTimeout(() => update(state), ms);
  };
  const refreshAll = () => { for (const s of bars.values()) { s.key = ''; schedule(s, 0); } };

  // Group editors only: editors that viewers embed (ide.createEditor) belong to no group and get no bar.
  ide.onEditor((ed) => {
    const g = ide.groups().find((x) => x.editor === ed);
    const body = g?.el.querySelector(':scope > .group-body');
    if (!body) return;
    const bar = el('div', 'nb-bar hidden');
    g.el.insertBefore(bar, body);
    const state = { ed, bar, timer: 0, seq: 0, key: '' };
    bars.set(ed, state);
    ed.onDidChangeModel(() => schedule(state, 0));
    ed.onDidChangeCursorPosition(() => schedule(state, CURSOR_DEBOUNCE));
    ed.onDidChangeModelContent(() => schedule(state, EDIT_DEBOUNCE));
    ed.onDidDispose(() => { clearTimeout(state.timer); bars.delete(ed); bar.remove(); });
    schedule(state, 0);
  });

  ide.on('settingsChanged', (key) => { if (key === SETTING) refreshAll(); });
  ide.on('projectOpened', refreshAll);
  // A request made before Pyright was ready answers nothing; ask again once it has analyzed the file.
  ide.on('problemsChanged', () => {
    for (const s of bars.values()) {
      const model = s.ed.getModel();
      if (model && symbolCache.get(model)?.empty) { symbolCache.delete(model); s.key = ''; schedule(s, CURSOR_DEBOUNCE); }
    }
  });

  (ide.settingsPages ||= []).push({
    id: 'breadcrumbs', group: 'editor', title: () => tr('Breadcrumbs'), defaults: { [SETTING]: true },
    keywords: 'breadcrumbs navigation path class function 이동 경로 탐색',
    mount(host, ctx) {
      const s = ctx.ui.section(host, tr('Breadcrumbs'));
      s.appendChild(ctx.ui.checkbox(SETTING, tr('Show breadcrumbs above the editor')));
      host.appendChild(Object.assign(document.createElement('div'), {
        className: 'muted settings-note', textContent: tr('Breadcrumbs show the file path and the classes and functions around the caret.'),
      }));
    },
  });

  // ---------- Call Hierarchy tool window ----------
  let mode = 'callers'; // 'callers' (incoming calls) | 'callees' (outgoing calls)
  let rootItem = null;
  let root = null;
  let selected = null;
  let visibleNodes = [];
  let headEl;
  let treeEl;
  let modeButtons = {};

  const sameItem = (a, b) => a.uri === b.uri && a.selectionRange.start.line === b.selectionRange.start.line
    && a.selectionRange.start.character === b.selectionRange.start.character;
  const newNode = (item, parent, sites = [], siteUri = item.uri) => {
    let recursive = false;
    for (let p = parent; p; p = p.parent) if (sameItem(p.item, item)) recursive = true;
    return { item, parent, sites, siteUri, children: recursive ? [] : null, expanded: false, loading: false, recursive };
  };

  const tw = ide.registerToolWindow({
    id: 'CallHierarchy', title: tr('Hierarchy'), icon: '⇅', side: 'bottom', order: 19,
    mount(container) {
      const bar = el('div', 'nb-ch-toolbar');
      for (const [id, label] of [['callers', tr('Caller Hierarchy')], ['callees', tr('Callee Hierarchy')]]) {
        const b = el('button', 'nb-ch-mode', label);
        b.dataset.mode = id;
        b.onclick = () => setMode(id);
        modeButtons[id] = b;
        bar.appendChild(b);
      }
      headEl = el('div', 'nb-ch-head muted');
      headEl.append(ide.keymap.text(el('span'), () => tr('Use {action} on a function to see its callers and callees', { action: ide.keymap.withKeys(tr('Call Hierarchy'), 'CallHierarchy') })));
      treeEl = el('div', 'list nb-ch-tree');
      treeEl.id = 'nbCallTree';
      treeEl.tabIndex = 0;
      treeEl.onkeydown = onTreeKey;
      bar.appendChild(headEl);
      container.append(bar, treeEl);
      paintModes();
    },
  });

  function paintModes() {
    for (const [id, b] of Object.entries(modeButtons)) b.classList.toggle('on', id === mode);
  }

  function setMode(m) {
    mode = m;
    paintModes();
    if (rootItem) setRoot(rootItem);
  }

  function setRoot(item) {
    rootItem = item;
    root = newNode(item, null);
    selected = root;
    const [before, after = ''] = (mode === 'callers' ? tr('Callers of {name}') : tr('Callees of {name}')).split('{name}');
    headEl.replaceChildren(el('span', null, before), userText(el('b', null, item.name)), el('span', null, after));
    headEl.classList.remove('muted');
    toggle(root, true);
  }

  async function loadChildren(node) {
    if (node.children || node.loading) return;
    node.loading = true;
    const owner = root;
    const incoming = mode === 'callers';
    const res = await ide.lsp.request(incoming ? 'callHierarchy/incomingCalls' : 'callHierarchy/outgoingCalls', { item: node.item });
    node.loading = false;
    if (owner !== root) return;
    // Incoming call sites are in the caller; outgoing ones are in this node's own file.
    node.children = (res || []).map((c) => (incoming ? newNode(c.from, node, c.fromRanges, c.from.uri) : newNode(c.to, node, c.fromRanges, node.item.uri)))
      .sort((a, b) => ide.util.rel(toPath(a.item.uri)).localeCompare(ide.util.rel(toPath(b.item.uri))) || a.item.range.start.line - b.item.range.start.line);
    paint();
  }

  function toggle(node, open = !node.expanded) {
    node.expanded = open;
    if (open) loadChildren(node);
    paint();
  }

  function rowFor(n, depth) {
    const row = el('div', `list-row nb-ch-row${n === selected ? ' selected' : ''}`);
    row.dataset.name = n.item.name;
    row.dataset.depth = depth;
    row.style.paddingLeft = `${6 + depth * 16}px`;
    const leaf = n.recursive || (n.children && !n.children.length);
    const arrow = el('span', 'nb-ch-arrow', leaf ? '' : n.expanded ? '▾' : '▸');
    arrow.onclick = (e) => { e.stopPropagation(); if (!leaf) toggle(n); };
    const path = toPath(n.item.uri);
    const line = (n.sites[0] || n.item.selectionRange).start.line + 1;
    const where = n.parent ? `${basename(toPath(n.siteUri))}:${line}` : `${basename(path)}:${line}`;
    row.append(arrow, kindIcon(n.item.kind), userText(el('span', 'nb-ch-name', n.item.name)),
      userText(el('span', 'muted', n.item.detail ? `  ${n.item.detail}` : '')), userText(el('span', 'muted nb-ch-where', `  (${where})`)));
    if (n.loading) row.appendChild(el('span', 'muted', `  ${tr('Loading…')}`));
    row.onclick = () => { selected = n; paint(); treeEl.focus(); };
    row.ondblclick = () => jump(n);
    return row;
  }

  function paint() {
    if (!treeEl) return;
    visibleNodes = [];
    const rows = [];
    const walk = (n, depth) => {
      visibleNodes.push(n);
      rows.push(rowFor(n, depth));
      if (n.expanded && n.children) for (const c of n.children) walk(c, depth + 1);
    };
    if (root) walk(root, 0);
    treeEl.replaceChildren(...rows);
    treeEl.querySelector('.selected')?.scrollIntoView({ block: 'nearest' });
  }

  // The root opens at its name; any other node at its first call site.
  function jump(n) {
    const r = n.parent ? n.sites[0] || n.item.selectionRange : n.item.selectionRange;
    const uri = n.parent && n.sites[0] ? n.siteUri : n.item.uri;
    ide.openFile(toPath(uri), { line: r.start.line + 1, col: r.start.character + 1 });
  }

  function onTreeKey(e) {
    const i = visibleNodes.indexOf(selected);
    const n = selected;
    const handled = {
      ArrowDown: () => { selected = visibleNodes[Math.min(i + 1, visibleNodes.length - 1)]; paint(); },
      ArrowUp: () => { selected = visibleNodes[Math.max(i - 1, 0)]; paint(); },
      ArrowRight: () => n && !n.expanded && toggle(n, true),
      ArrowLeft: () => { if (n?.expanded) toggle(n, false); else if (n?.parent) { selected = n.parent; paint(); } },
      Enter: () => n && jump(n),
    }[e.key];
    if (!handled || !n) return;
    e.preventDefault();
    e.stopPropagation();
    handled();
  }

  const hint = (ed, text) => ed.getContribution('editor.contrib.messageController')?.showMessage(text, ed.getPosition());

  // PyCharm takes the function around the caret when the caret is not on a name, so fall back to the innermost scope.
  async function showCallHierarchy(ed) {
    const model = ed?.getModel();
    const pos = ed?.getPosition();
    if (!isPy(modelPath(model)) || !pos) return;
    const prepare = (p) => ide.lsp.request('textDocument/prepareCallHierarchy', { textDocument: { uri: model.uri.toString() }, position: p });
    let items = await prepare({ line: pos.lineNumber - 1, character: pos.column - 1 });
    if (!items?.length) {
      const inner = chainAt(await symbolsOf(model), pos).pop()?.sym;
      if (inner) items = await prepare(inner.selectionRange.start);
    }
    if (!items?.length) return hint(ed, tr('No call hierarchy for the element at the caret'));
    tw.show();
    setRoot(items[0]);
  }

  const editorPython = () => !!ide.editor?.hasTextFocus() && isPy(modelPath(ide.editor.getModel()));
  [
    { id: 'CallHierarchy', title: tr('Call Hierarchy'), keys: 'Ctrl+Alt+H', when: editorPython, run: () => showCallHierarchy(ide.editor) },
    { id: 'EditorToggleShowBreadcrumbs', title: tr('Show Breadcrumbs'), run: () => ide.settings.set(SETTING, !shown()) },
  ].forEach(ide.registerAction);

  ide.onEditor((ed) => ed.addAction({
    id: 'pyide.callHierarchy', label: tr('Call Hierarchy'), contextMenuGroupId: 'navigation', contextMenuOrder: 3,
    precondition: 'editorLangId == python', run: () => showCallHierarchy(ed),
  }));

  ide.navigationBar = { showCallHierarchy: () => showCallHierarchy(ide.editor), mode: () => mode, setMode };
})();
