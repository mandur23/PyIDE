// Search and navigation: Find/Replace in Files, Recent Files/Locations, Back/Forward, Structure, Go to Class/Symbol, TODO.
(() => {
  const { el, basename, dirname, samePath, rel } = ide.util;
  const isPy = (p) => /\.py[iw]?$/i.test(p);
  const fileIcon = (p) => ide.fileIcon(p);
  const LETTER = { class: 'C', method: 'm', function: 'f', field: 'f', variable: 'v', property: 'p' };
  const GLYPH = { class: 'Ⓒ', method: 'ⓜ', function: 'ⓕ', field: 'ⓕ', variable: 'ⓥ', property: 'ⓟ' };
  const kindIcon = (kind) => el('span', `sn-icon k-${kind}`, LETTER[kind] || '?');
  // Plural forms are separate whole messages (ngettext style) so a translation can reorder them.
  const nt = (n, one, many) => tr(n === 1 ? one : many, { n });
  const nt2 = (count, files, [oneOne, oneMany, manyOne, manyMany]) =>
    tr(count === 1 ? (files === 1 ? oneOne : oneMany) : (files === 1 ? manyOne : manyMany), { count, files });
  // Spans holding code, file names or symbol names: user data, never translated.
  const userText = (node) => { node.dataset.userText = ''; return node; };
  const KIND = { class: tr('class'), method: tr('method'), function: tr('function'), field: tr('field'), variable: tr('variable'), property: tr('property') };
  const debounce = (fn, ms) => { let t; return (...a) => { clearTimeout(t); t = setTimeout(() => fn(...a), ms); }; };
  const escapeRe = (s) => s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');

  function highlight(text, ranges, cls = 'sn-hit') {
    const frag = document.createDocumentFragment();
    let last = 0;
    for (const [s, e] of [...ranges].sort((a, b) => a[0] - b[0])) {
      if (s < last || e <= s) continue;
      frag.append(text.slice(last, s), el('span', cls, text.slice(s, e)));
      last = e;
    }
    frag.append(text.slice(last));
    return frag;
  }

  async function goTo(path, line, col = 1, len = 0) {
    const tab = await ide.openFile(path, { line, col });
    if (tab && len) ide.editor.setSelection(new ide.monaco.Selection(line, col, line, col + len));
    return tab;
  }

  // Unsaved editor contents take precedence over disk, as in PyCharm.
  const dirtyTexts = () => {
    const out = {};
    for (const t of ide.tabs) if (t.kind === 'file' && ide.isDirty(t)) out[t.path] = t.model.getValue();
    return out;
  };

  // Edits only the changed middle of the document so the caret and undo stack survive.
  function applyText(model, before, after) {
    let s = 0;
    while (s < before.length && s < after.length && before[s] === after[s]) s++;
    let e = 0;
    while (e < before.length - s && e < after.length - s && before[before.length - 1 - e] === after[after.length - 1 - e]) e++;
    const a = model.getPositionAt(s);
    const b = model.getPositionAt(before.length - e);
    model.pushEditOperations([], [{ range: new ide.monaco.Range(a.lineNumber, a.column, b.lineNumber, b.column), text: after.slice(s, after.length - e) }], () => null);
  }

  // Collapsible per-file group used by the Find and TODO tool windows; `collapsed` keeps state across refreshes.
  function fileGroup(path, countText, rows, collapsed) {
    const g = el('div', 'sn-group');
    const head = el('div', 'list-row sn-file');
    const isCollapsed = collapsed.has(path.toLowerCase());
    g.classList.toggle('collapsed', isCollapsed);
    const arrow = el('span', 'sn-arrow', isCollapsed ? '▸' : '▾');
    head.append(arrow, Object.assign(fileIcon(path), { className: 'file-icon sn-ficon' }), userText(el('span', 'sn-fname', basename(path))),
      userText(el('span', 'sn-fdir', rel(dirname(path)))), el('span', 'sn-count', countText));
    head.onclick = () => {
      const c = g.classList.toggle('collapsed');
      arrow.textContent = c ? '▸' : '▾';
      c ? collapsed.add(path.toLowerCase()) : collapsed.delete(path.toLowerCase());
    };
    const body = el('div', 'sn-children');
    body.append(...rows);
    g.append(head, body);
    return g;
  }

  function setAllCollapsed(list, collapsed, value) {
    for (const g of list.querySelectorAll('.sn-group')) {
      g.classList.toggle('collapsed', value);
      g.querySelector('.sn-arrow').textContent = value ? '▸' : '▾';
    }
    collapsed.clear();
    if (value) for (const n of list.querySelectorAll('.sn-group .sn-file')) collapsed.add(n.parentElement.dataset.path);
  }

  // ---------- Find / Replace in Files ----------
  const FIND_KEY = 'searchNav.find';
  let findOpts = { caseSensitive: false, words: false, regex: false, useMask: false, mask: '*.py', replacement: '', ...ide.settings.get(FIND_KEY, {}) };
  let lastQuery = '';
  let findState = null;
  let findHead;
  let findList;
  const findCollapsed = new Set();

  const searchOpts = (o) => ({ query: o.query, caseSensitive: o.caseSensitive, words: o.words, regex: o.regex,
    mask: o.useMask ? o.mask : '', dir: o.dir || null, replacement: o.replacement || '' });
  const runFind = (o) => ide.api.invoke('search:find', ide.root, searchOpts(o), dirtyTexts());
  const summaryOf = (res) => (res.error ? tr('Invalid regular expression: {message}', { message: res.error })
    : nt2(res.count, res.files.length, ['{count} match in {files} file', '{count} match in {files} files', '{count} matches in {files} file', '{count} matches in {files} files'])
      + (res.truncated ? ` ${tr('(results truncated)')}` : ''));

  // One row per line; every match on the line is highlighted, the first one is the jump target.
  function lineRows(matches) {
    const rows = [];
    for (const m of matches) {
      const last = rows[rows.length - 1];
      if (last && last.line === m.line) last.ranges.push([m.start, m.end]);
      else rows.push({ line: m.line, col: m.col, len: m.len, text: m.text, ranges: [[m.start, m.end]] });
    }
    for (const r of rows) {
      const lead = r.text.length - r.text.trimStart().length;
      r.text = r.text.slice(lead).trimEnd();
      r.ranges = r.ranges.map(([s, e]) => [Math.max(0, s - lead), Math.max(0, e - lead)]);
    }
    return rows;
  }

  const findTw = ide.registerToolWindow({
    id: 'FindInFiles', title: tr('Find in Files'), icon: '🔍', side: 'bottom', order: 20,
    mount(container, tw) {
      findHead = el('div', 'sn-head');
      findHead.id = 'snFindHead';
      findList = el('div', 'list sn-tree');
      findList.id = 'snFindResults';
      findHead.textContent = tr('Use Find in Files (Ctrl+Shift+F) to search the project');
      container.append(findHead, findList);
      tw.setActions([
        { icon: '⟳', title: tr('Rerun Search'), run: () => findState && showFindResults(findState.opts, findState.replace) },
        { icon: '⊞', title: tr('Expand All'), run: () => setAllCollapsed(findList, findCollapsed, false) },
        { icon: '⊟', title: tr('Collapse All'), run: () => setAllCollapsed(findList, findCollapsed, true) },
      ]);
    },
  });

  function matchRow(path, r) {
    const row = el('div', 'list-row sn-match');
    row.append(el('span', 'sn-ln', String(r.line)), userText(el('span', 'sn-text')));
    row.lastChild.append(highlight(r.text, r.ranges));
    row.onclick = () => {
      findList.querySelectorAll('.sn-match.selected').forEach((n) => n.classList.remove('selected'));
      row.classList.add('selected');
      goTo(path, r.line, r.col, r.len);
    };
    return row;
  }

  function renderFindResults(note) {
    const { opts: o, res, replace } = findState;
    findHead.replaceChildren(el('span', 'sn-title', replace
      ? tr("Replace: '{query}' → '{replacement}'", { query: o.query, replacement: o.replacement })
      : tr("Find: '{query}'", { query: o.query })));
    const scope = [o.dir ? tr('directory {name}', { name: rel(o.dir) || basename(o.dir) }) : tr('project'),
      o.useMask && o.mask ? tr('mask {mask}', { mask: o.mask }) : ''].filter(Boolean).join(', ');
    findHead.append(el('span', res.error ? 'sn-error' : 'muted', `${summaryOf(res)} · ${scope}`));
    if (note) findHead.append(el('span', 'sn-note', note));
    findHead.append(el('span', 'spacer'));
    if (replace && res.files.length) {
      const b = el('button', 'secondary sn-btn', tr('Replace All'));
      b.id = 'snReplaceAll';
      b.onclick = () => replaceAll(o, res);
      findHead.append(b);
    }
    findList.replaceChildren();
    for (const f of res.files) {
      const g = fileGroup(f.path, nt(f.matches.length, '{n} match', '{n} matches'), lineRows(f.matches).map((r) => matchRow(f.path, r)), findCollapsed);
      g.dataset.path = f.path.toLowerCase();
      findList.append(g);
    }
    if (!res.files.length && !res.error) findList.append(el('div', 'list-row muted', tr('No matches found')));
    findTw.setBadge('');
  }

  async function showFindResults(o, replace, note) {
    findTw.show();
    findHead.replaceChildren(el('span', 'muted', tr("Searching for '{query}'…", { query: o.query })));
    const res = await runFind(o);
    findState = { opts: o, res, replace };
    renderFindResults(note);
  }

  async function replaceAll(o, res) {
    res = res || (await runFind(o));
    if (res.error || !res.files.length) return showFindResults(o, true);
    const changed = [];
    const onDisk = [];
    let count = 0;
    for (const f of res.files) {
      const tab = ide.findTab(f.path);
      if (tab?.kind === 'file' && ide.isDirty(tab)) {
        // Unsaved buffers are edited in place and stay unsaved, like PyCharm's document-level replace. The text is
        // replaced by main's search:replaceText, the same code that replaces files on disk.
        const before = tab.model.getValue();
        const { text: after, count: n } = await ide.api.invoke('search:replaceText', searchOpts(o), before);
        if (!n || after === before || tab.model.getValue() !== before) continue;
        applyText(tab.model, before, after);
        count += n;
        changed.push(f.path);
      } else onDisk.push(f.path);
    }
    const r = await ide.api.invoke('search:replace', searchOpts(o), onDisk);
    count += r.count;
    changed.push(...r.changed);
    await ide.reloadFromDisk(r.changed);
    await ide.refreshTree();
    ide.renderTabs();
    ide.api.invoke('search:invalidate', changed);
    refreshTodos();
    await showFindResults(o, true, nt2(count, changed.length, ['Replaced {count} occurrence in {files} file', 'Replaced {count} occurrence in {files} files',
      'Replaced {count} occurrences in {files} file', 'Replaced {count} occurrences in {files} files']));
  }

  function selectedText() {
    const sel = ide.editor?.getSelection();
    const model = ide.editor?.getModel();
    if (!sel || !model || sel.isEmpty() || sel.startLineNumber !== sel.endLineNumber) return '';
    return model.getValueInRange(sel);
  }

  function openFindDialog(replace, dir = null) {
    if (!ide.root) return;
    const o = { ...findOpts, query: selectedText() || lastQuery, dir };
    const body = el('div', 'sn-find');
    const qWrap = el('div', 'sn-qwrap');
    const q = el('input', 'input sn-q');
    q.id = 'snQuery';
    q.placeholder = tr('Search text');
    q.spellcheck = false;
    q.value = o.query;
    const toggles = el('span', 'sn-toggles');
    const btn = {};
    const flip = (key) => { o[key] = !o[key]; btn[key].classList.toggle('on', o[key]); update(); };
    for (const [key, label, title] of [['caseSensitive', 'Cc', tr('Match Case (Alt+C)')], ['words', 'W', tr('Words (Alt+W)')], ['regex', '.*', tr('Regex (Alt+X)')]]) {
      const b = el('button', `sn-toggle${o[key] ? ' on' : ''}`, label);
      b.title = title;
      b.dataset.opt = key;
      b.tabIndex = -1;
      b.onclick = () => { flip(key); q.focus(); };
      toggles.append((btn[key] = b));
    }
    qWrap.append(q, toggles);
    body.append(qWrap);
    let r;
    if (replace) {
      r = el('input', 'input sn-r');
      r.id = 'snReplace';
      r.placeholder = tr('Replace with');
      r.spellcheck = false;
      r.value = o.replacement;
      body.append(r);
    }
    const filters = el('div', 'sn-filters');
    const maskLbl = el('label', 'sn-mask-lbl');
    const maskOn = el('input');
    maskOn.type = 'checkbox';
    maskOn.id = 'snMaskOn';
    maskOn.checked = o.useMask;
    maskLbl.append(maskOn, document.createTextNode(tr('File mask:')));
    const mask = el('input', 'input sn-mask');
    mask.id = 'snMask';
    mask.value = o.mask;
    mask.disabled = !o.useMask;
    filters.append(el('span', 'sn-scope', dir ? tr('Directory: {name}', { name: rel(dir) || basename(dir) }) : tr('In Project')), el('span', 'spacer'), maskLbl, mask);
    const status = el('div', 'sn-status muted');
    status.id = 'snStatus';
    const preview = el('div', 'sn-preview');
    preview.id = 'snPreview';
    body.append(filters, status, preview);

    const sync = () => {
      o.query = q.value;
      o.mask = mask.value;
      if (r) o.replacement = r.value;
      lastQuery = o.query;
      findOpts = { caseSensitive: o.caseSensitive, words: o.words, regex: o.regex, useMask: o.useMask, mask: o.mask, replacement: replace ? o.replacement : findOpts.replacement };
      ide.settings.set(FIND_KEY, findOpts);
    };
    let seq = 0;
    const update = debounce(async () => {
      sync();
      const my = ++seq;
      if (!o.query) { status.textContent = ''; preview.replaceChildren(); return; }
      const res = await runFind(o);
      if (my !== seq) return;
      status.textContent = summaryOf(res);
      status.classList.toggle('sn-error', !!res.error);
      preview.replaceChildren();
      let n = 0;
      for (const f of res.files) {
        for (const row of lineRows(f.matches)) {
          if (n++ >= 200) break;
          const node = el('div', 'sn-prow');
          node.append(userText(el('span', 'sn-text')), userText(el('span', 'sn-ploc', `${basename(f.path)} ${row.line}`)));
          node.firstChild.append(highlight(row.text, row.ranges));
          node.onclick = () => { dlg.close(); goTo(f.path, row.line, row.col, row.len); };
          preview.append(node);
        }
      }
    }, 150);
    q.oninput = update;
    mask.oninput = update;
    maskOn.onchange = () => { o.useMask = maskOn.checked; mask.disabled = !o.useMask; (o.useMask ? mask : q).focus(); update(); };
    body.addEventListener('keydown', (e) => {
      if (!e.altKey || e.ctrlKey) return;
      const key = { KeyC: 'caseSensitive', KeyW: 'words', KeyX: 'regex' }[e.code];
      if (key) { e.preventDefault(); flip(key); }
    });

    const toWindow = () => {
      sync();
      if (!o.query) return false;
      showFindResults({ ...o }, replace);
    };
    const buttons = [{ label: tr('Open in Find Window'), primary: true, run: toWindow }];
    if (replace) buttons.unshift({ label: tr('Replace All'), run: async () => { sync(); if (!o.query) return false; await replaceAll({ ...o }); } });
    const dlg = ide.ui.dialog({ title: replace ? tr('Replace in Files') : tr('Find in Files'), body, buttons, width: 780 });
    q.select();
    update();
  }

  // ---------- Recent Files ----------
  let recent = [];
  const recentKey = () => `searchNav.recentFiles.${ide.root}`;
  const saveRecent = debounce(() => ide.root && ide.settings.set(recentKey(), recent), 500);

  async function showRecentFiles() {
    const exists = await Promise.all(recent.map((p) => ide.api.exists(p)));
    const list = recent.filter((_, i) => exists[i]);
    if (!list.length) return;
    const chosen = ide.ui.pick({
      placeholder: tr('Recent Files'),
      // Every row gets a detail: the core picker ranks rows with a detail above rows without one, which would break recency order.
      items: list.map((p) => ({ label: basename(p), detail: rel(dirname(p)) || basename(ide.root), icon: fileIcon(p), value: p })),
    });
    // PyCharm preselects the previous file so Ctrl+E, Enter flips between the last two.
    const rows = document.querySelectorAll('#popupList .popup-item:not(.hint)');
    if (rows.length > 1 && samePath(list[0], ide.active)) {
      rows[0].classList.remove('active');
      rows[1].classList.add('active');
    }
    const p = await chosen;
    if (p) ide.openFile(p);
  }

  // ---------- Navigation history (Back/Forward), edit locations, Recent Locations ----------
  const JUMP = 10;
  let back = [];
  let fwd = [];
  let cur = null;
  let quiet = false;
  let settling = false;
  let edits = [];
  let editIdx = null;
  let places = [];
  const sameLine = (a, b) => !!a && !!b && samePath(a.path, b.path) && a.line === b.line;
  const near = (a, b, d) => samePath(a.path, b.path) && Math.abs(a.line - b.line) <= d;

  function lineText(loc) {
    const t = ide.findTab(loc.path);
    return t?.kind === 'file' && loc.line <= t.model.getLineCount() ? t.model.getLineContent(loc.line).trim() : null;
  }

  function rememberPlace(loc, edited) {
    const prev = places.find((p) => near(p, loc, 2));
    places = places.filter((p) => p !== prev);
    places.unshift({ ...loc, edited: edited || !!prev?.edited, text: lineText(loc) ?? prev?.text ?? '' });
    if (places.length > 50) places.length = 50;
  }

  function pushBack(loc) {
    if (!sameLine(back[back.length - 1], loc)) back.push(loc);
    if (back.length > 100) back.shift();
    fwd = [];
    rememberPlace(loc, false);
  }

  // A file switch or a caret jump of JUMP+ lines records the place being left, like PyCharm's IdeDocumentHistory.
  function track(path, line, col) {
    if (!quiet && cur) {
      const switched = !samePath(cur.path, path);
      if (switched || (!settling && Math.abs(cur.line - line) >= JUMP)) pushBack(cur);
      // openFile() activates the tab and then moves the caret in the same tick; that move belongs to the switch.
      if (switched) { settling = true; setTimeout(() => (settling = false)); }
    }
    cur = { path, line, col };
  }

  async function navigate(from, to) {
    let target;
    while ((target = from.pop()) && (sameLine(target, cur) || !(await ide.api.exists(target.path))));
    if (!target) return;
    if (cur && !sameLine(to[to.length - 1], cur)) to.push(cur);
    quiet = true;
    try { await goTo(target.path, target.line, target.col); } finally { setTimeout(() => (quiet = false)); }
    cur = target;
  }

  async function lastEdit() {
    let i = editIdx ?? edits.length - 1;
    const tab = ide.activeTab();
    const pos = ide.editor.getPosition();
    if (edits[i] && tab && pos && sameLine(edits[i], { path: tab.path, line: pos.lineNumber })) i--;
    while (i >= 0 && !(await ide.api.exists(edits[i].path))) i--;
    if (i < 0) return;
    editIdx = i;
    await goTo(edits[i].path, edits[i].line, edits[i].col);
  }

  async function showRecentLocations() {
    const items = places.filter((p) => !(cur && near(p, cur, 0))).map((p) => ({
      label: `${basename(p.path)}:${p.line}`, detail: lineText(p) || p.text || ' ', hint: p.edited ? tr('changed') : '', icon: fileIcon(p.path), value: p,
    }));
    const p = await ide.ui.pick({ placeholder: tr('Recent Locations'), items });
    if (p) goTo(p.path, p.line, p.col);
  }

  const CursorReason = ide.monaco.editor.CursorChangeReason;
  // History follows the pane the user works in: the active pane's editor, or a focused editor inside a viewer.
  // Other panes showing the same file also move their carets when it is edited; those moves are not navigation.
  const driving = (ed) => ed === ide.editor || (ed.hasTextFocus() && !ide.editors().includes(ed));
  const pathOf = (ed) => { const m = ed.getModel(); return m ? ide.tabs.find((t) => t.model === m)?.path || null : null; };

  ide.onEditor((ed) => {
    ed.onDidChangeCursorPosition((e) => {
      const path = driving(ed) && pathOf(ed);
      if (!path) return;
      const { lineNumber: line, column: col } = e.position;
      if ([CursorReason.Paste, CursorReason.Undo, CursorReason.Redo, CursorReason.ContentFlush].includes(e.reason) && cur && samePath(cur.path, path)) {
        cur = { path, line, col };
      } else track(path, line, col);
      markCurrentSoon();
    });

    ed.onDidChangeModelContent((e) => {
      refreshStructureSoon();
      const model = ed.getModel();
      const path = !e.isFlush && driving(ed) && pathOf(ed);
      if (!path) return;
      setTimeout(() => {
        if (ed.getModel() !== model) return;
        const pos = ed.getPosition();
        const loc = { path, line: pos.lineNumber, col: pos.column };
        const last = edits[edits.length - 1];
        if (last && near(last, loc, 1)) edits[edits.length - 1] = loc; else edits.push(loc);
        if (edits.length > 100) edits.shift();
        editIdx = null;
        rememberPlace(loc, true);
      });
    });
  });

  ide.on('activeTabChanged', (tab) => {
    if (tab?.kind === 'file') {
      const pos = ide.editor.getPosition();
      track(tab.path, pos?.lineNumber || 1, pos?.column || 1);
      if (ide.root) {
        recent = [tab.path, ...recent.filter((p) => !samePath(p, tab.path))].slice(0, 50);
        saveRecent();
      }
    }
    refreshStructure();
  });

  // ---------- Structure (Alt+7) and File Structure popup (Ctrl+F12) ----------
  let outline = null;
  let outlineReq = null;
  let structList;
  let sortAlpha = ide.settings.get('searchNav.structureSort', false);
  const structCollapsed = new Set();

  async function getOutline(tab) {
    const version = tab.model.getAlternativeVersionId();
    if (outline && samePath(outline.path, tab.path) && outline.version === version) return outline;
    if (outlineReq && samePath(outlineReq.path, tab.path) && outlineReq.version === version) return outlineReq.promise;
    const interp = ide.currentInterp();
    const text = tab.model.getValue();
    const promise = (async () => {
      if (!interp) return { path: tab.path, version, items: [], error: tr('No Python interpreter configured') };
      const r = await ide.api.invoke('search:outline', interp, text);
      // On a syntax error keep showing the last good outline of this file, as PyCharm does.
      const keep = outline && samePath(outline.path, tab.path) ? outline.items : [];
      return { path: tab.path, version, items: r.items || keep, error: !r.error ? null
        : r.line ? tr('Syntax error: {message} (line {line})', { message: r.error, line: r.line }) : tr(r.error) };
    })();
    outlineReq = { path: tab.path, version, promise };
    const res = await promise;
    if (outlineReq?.promise === promise) outlineReq = null;
    if (!outline || !samePath(outline.path, res.path) || outline.version <= res.version) outline = res;
    return res;
  }

  const structTw = ide.registerToolWindow({
    id: 'Structure', title: tr('Structure'), icon: '⧉', side: 'left', keys: 'Alt+7', order: 20,
    mount(container, tw) {
      structList = el('div', 'sn-struct');
      structList.id = 'snStructure';
      container.append(structList);
      tw.setActions([
        { icon: '⇅', title: tr('Sort Alphabetically'), run: () => { sortAlpha = !sortAlpha; ide.settings.set('searchNav.structureSort', sortAlpha); refreshStructure(); } },
        { icon: '⊞', title: tr('Expand All'), run: () => { structCollapsed.clear(); refreshStructure(); } },
        { icon: '⊟', title: tr('Collapse All'), run: () => { structList.querySelectorAll('.sn-node[data-key]').forEach((n) => n.dataset.parent === '1' && structCollapsed.add(n.dataset.key)); refreshStructure(); } },
      ]);
    },
  });

  function renderStructure(tab, o) {
    structList.replaceChildren();
    const head = el('div', 'sn-node sn-root');
    head.append(el('span', 'sn-arrow', '▾'), Object.assign(fileIcon(tab.path), { className: 'file-icon sn-ficon' }), userText(el('span', 'sn-name', tab.title)));
    structList.append(head);
    if (o.error) structList.append(el('div', 'sn-node sn-err', o.error));
    const add = (items, depth, prefix) => {
      const list = sortAlpha ? [...items].sort((a, b) => a.name.localeCompare(b.name)) : items;
      for (const it of list) {
        const key = `${prefix}/${it.kind}:${it.name}`;
        const open = !structCollapsed.has(key);
        const row = el('div', 'sn-node');
        row.style.paddingLeft = `${depth * 16 + 4}px`;
        Object.assign(row.dataset, { key, line: it.line, end: it.endLine, name: it.name, kind: it.kind, depth, parent: it.children.length ? '1' : '' });
        const arrow = el('span', 'sn-arrow', it.children.length ? (open ? '▾' : '▸') : '');
        arrow.onclick = (e) => {
          e.stopPropagation();
          open ? structCollapsed.add(key) : structCollapsed.delete(key);
          renderStructure(tab, o);
        };
        row.append(arrow, kindIcon(it.kind), userText(el('span', 'sn-name', it.name)), userText(el('span', 'sn-detail', it.detail)));
        row.onclick = () => goTo(tab.path, it.line, it.col);
        structList.append(row);
        if (open && it.children.length) add(it.children, depth + 1, key);
      }
    };
    add(o.items, 1, tab.path.toLowerCase());
    if (!o.items.length && !o.error) structList.append(el('div', 'sn-node muted', tr('No structure elements')));
    markCurrent();
  }

  async function refreshStructure() {
    if (!structList || !structTw.isVisible()) return;
    const tab = ide.activeTab();
    if (tab?.kind !== 'file' || !isPy(tab.path)) {
      structList.replaceChildren(el('div', 'sn-node muted', tab ? tr('Structure is not available for this file') : tr('No file is open')));
      return;
    }
    const o = await getOutline(tab);
    if (ide.activeTab() === tab && structTw.isVisible()) renderStructure(tab, o);
  }
  const refreshStructureSoon = debounce(refreshStructure, 400);

  // Highlights the innermost element containing the caret; rows are in document order so the last hit is the deepest.
  function markCurrent() {
    if (!structList || !structTw.isVisible()) return;
    const line = ide.editor.getPosition()?.lineNumber;
    let best = null;
    for (const row of structList.querySelectorAll('.sn-node[data-line]')) {
      row.classList.remove('selected');
      if (line >= +row.dataset.line && line <= +row.dataset.end) best = row;
    }
    best?.classList.add('selected');
  }
  const markCurrentSoon = debounce(markCurrent, 100);

  async function fileStructurePopup() {
    const tab = ide.activeTab();
    if (tab?.kind !== 'file' || !isPy(tab.path) || document.getElementById('snFileStructure')) return;
    const o = await getOutline(tab);
    if (ide.activeTab() !== tab) return;
    const caret = ide.editor.getPosition()?.lineNumber || 1;
    const flat = [];
    const walk = (items, depth, parent) => {
      for (const it of items) {
        const n = { it, depth, parent };
        flat.push(n);
        walk(it.children, depth + 1, n);
      }
    };
    walk(o.items, 0, null);

    const box = el('div', 'sn-fs');
    box.id = 'snFileStructure';
    const head = el('div', 'sn-fs-head');
    head.append(userText(el('span', null, tab.title)), el('span', 'sn-err', o.error ? `  ${o.error}` : ''));
    const input = el('input', 'sn-fs-in');
    input.placeholder = tr('Type to filter');
    input.spellcheck = false;
    const list = el('div', 'sn-fs-list');
    box.append(head, input, list);
    // Living in #dialogHost suspends the global keymap while the popup is open.
    document.getElementById('dialogHost').appendChild(box);

    let rows = [];
    let active = -1;
    const close = () => box.remove();
    const choose = (n) => { close(); goTo(tab.path, n.it.line, n.it.col); };
    const setActive = (i) => {
      rows[active]?.classList.remove('active');
      active = i;
      rows[i]?.classList.add('active');
      rows[i]?.scrollIntoView({ block: 'nearest' });
    };
    const render = () => {
      const q = input.value.trim();
      let visible = flat;
      if (q) {
        const keep = new Set();
        for (const n of flat) if (matchScore(n.it.name, q) > 0) for (let p = n; p && !keep.has(p); p = p.parent) keep.add(p);
        visible = flat.filter((n) => keep.has(n));
      }
      list.replaceChildren();
      active = -1;
      rows = visible.map((n) => {
        const hit = !q || matchScore(n.it.name, q) > 0;
        const row = el('div', `sn-fs-row${hit ? '' : ' dim'}`);
        row.style.paddingLeft = `${n.depth * 18 + 10}px`;
        row.append(kindIcon(n.it.kind), userText(el('span', 'sn-name', n.it.name)), userText(el('span', 'sn-detail', n.it.detail)));
        row.onmousedown = (e) => { e.preventDefault(); choose(n); };
        row._node = n;
        row._hit = hit;
        list.append(row);
        return row;
      });
      if (!rows.length) list.append(el('div', 'sn-fs-row muted', tr('Nothing found')));
      const idx = q ? rows.findIndex((r) => r._hit)
        : rows.reduce((best, r, i) => (r._node.it.line <= caret && caret <= r._node.it.endLine ? i : best), -1);
      setActive(Math.max(0, idx));
    };
    input.oninput = render;
    input.onkeydown = (e) => {
      if (e.key === 'Escape') { e.preventDefault(); close(); ide.editor.focus(); } else if (e.key === 'ArrowDown' || e.key === 'ArrowUp') {
        e.preventDefault();
        if (rows.length) setActive((active + (e.key === 'ArrowDown' ? 1 : -1) + rows.length) % rows.length);
      } else if (e.key === 'Enter') {
        e.preventDefault();
        if (rows[active]?._node) choose(rows[active]._node);
      }
    };
    input.onblur = () => setTimeout(() => box.isConnected && document.activeElement !== input && close(), 120);
    render();
    input.focus();
  }

  // ---------- Go to Class / Go to Symbol ----------
  // PyCharm-style matching: exact, prefix, CamelHumps/snake_humps ("UM" -> UserModel), substring, and * wildcards.
  function humps(name, q) {
    const upper = (c) => c >= 'A' && c <= 'Z';
    const start = (k) => k === 0 || name[k - 1] === '_' || (upper(name[k]) && !upper(name[k - 1]));
    let i = 0;
    for (let j = 0; j < q.length; j++) {
      const c = q[j].toLowerCase();
      if (c === '_') continue;
      if (j > 0 && i < name.length && name[i].toLowerCase() === c && !(upper(q[j]) && !start(i))) { i++; continue; }
      let k = i;
      while (k < name.length && !(start(k) && name[k].toLowerCase() === c)) k++;
      if (k >= name.length) return false;
      i = k + 1;
    }
    return true;
  }

  function matchScore(name, q) {
    if (!q) return 1;
    const n = name.toLowerCase();
    const l = q.toLowerCase();
    if (q.includes('*')) return new RegExp(l.split('*').map(escapeRe).join('.*')).test(n) ? 30 : 0;
    if (n === l) return name === q ? 100 : 95;
    if (n.startsWith(l)) return 80;
    if (humps(name, q)) return 60;
    return n.includes(l) ? 40 : 0;
  }

  function rankSymbols(list, query) {
    let q = query.trim();
    let scope = '';
    const dot = q.lastIndexOf('.');
    if (dot >= 0) { scope = q.slice(0, dot).toLowerCase(); q = q.slice(dot + 1); }
    const scored = [];
    for (const s of list) {
      if (scope && !s.container.toLowerCase().includes(scope) && !rel(s.path).toLowerCase().replace(/[\\/]/g, '.').includes(scope)) continue;
      const sc = matchScore(s.name, q);
      if (sc > 0) scored.push([s, sc]);
    }
    scored.sort((a, b) => b[1] - a[1] || a[0].name.length - b[0].name.length || a[0].name.localeCompare(b[0].name));
    return scored.slice(0, 100).map(([s]) => ({
      label: s.name, detail: `${s.container ? `${s.container} · ` : ''}${rel(s.path)}`, hint: KIND[s.kind] || s.kind, icon: GLYPH[s.kind] || '•', value: s,
    }));
  }

  const loadIndex = () => {
    const interp = ide.currentInterp();
    return interp && ide.root ? ide.api.invoke('search:symbols', interp, ide.root) : Promise.resolve([]);
  };

  async function gotoSymbol(classesOnly) {
    if (!ide.root) return;
    const index = loadIndex();
    const s = await ide.ui.pick({
      placeholder: classesOnly ? tr('Enter class name') : tr('Enter symbol name'),
      items: async (q) => rankSymbols((await index).filter((x) => !classesOnly || x.kind === 'class'), q),
    });
    if (s) goTo(s.path, s.line, s.col, s.name.length);
  }

  // ---------- TODO ----------
  let todoHead;
  let todoList;
  const todoCollapsed = new Set();
  const todoTw = ide.registerToolWindow({
    id: 'TODO', title: 'TODO', icon: '☑', side: 'bottom', order: 50,
    mount(container, tw) {
      todoHead = el('div', 'sn-head');
      todoHead.id = 'snTodoHead';
      todoList = el('div', 'list sn-tree');
      todoList.id = 'snTodo';
      container.append(todoHead, todoList);
      tw.setActions([
        { icon: '⟳', title: tr('Refresh'), run: () => refreshTodosNow() },
        { icon: '⊞', title: tr('Expand All'), run: () => setAllCollapsed(todoList, todoCollapsed, false) },
        { icon: '⊟', title: tr('Collapse All'), run: () => setAllCollapsed(todoList, todoCollapsed, true) },
      ]);
    },
  });

  async function refreshTodosNow() {
    if (!ide.root) return;
    const res = await ide.api.invoke('search:todos', ide.root, dirtyTexts());
    todoHead.replaceChildren(el('span', null, nt2(res.count, res.files.length, ['Found {count} TODO item in {files} file',
      'Found {count} TODO item in {files} files', 'Found {count} TODO items in {files} file', 'Found {count} TODO items in {files} files'])));
    todoList.replaceChildren(...res.files.map((f) => {
      const rows = f.items.map((it) => {
        const row = el('div', 'list-row sn-match sn-todo');
        row.append(el('span', 'sn-ln', `(${it.line}, ${it.col})`), userText(el('span', 'sn-todo-text')));
        row.lastChild.append(highlight(it.text, [[0, it.kwLen]], 'sn-todo-kw'));
        row.onclick = () => goTo(f.path, it.line, it.col);
        return row;
      });
      const g = fileGroup(f.path, nt(f.items.length, '{n} item', '{n} items'), rows, todoCollapsed);
      g.dataset.path = f.path.toLowerCase();
      return g;
    }));
    if (!res.files.length) todoList.append(el('div', 'list-row muted', tr('No TODO items found')));
  }
  const refreshTodos = debounce(refreshTodosNow, 300);

  // ---------- wiring ----------
  ide.on('projectOpened', () => {
    recent = ide.settings.get(recentKey(), []);
    back = []; fwd = []; cur = null; edits = []; editIdx = null; places = [];
    outline = null;
    refreshTodosNow();
    setTimeout(loadIndex, 1500);
  });
  ide.on('fileSaved', (tab) => {
    ide.api.invoke('search:invalidate', [tab.path]);
    refreshTodos();
  });
  ide.on('filesChanged', (c = {}) => {
    const paths = [...(c.created || []), ...(c.deleted || []), ...(c.renamed || []).flat()];
    ide.api.invoke('search:invalidate', paths.length ? paths : null);
    refreshTodos();
  });
  ide.on('toolWindowShown', (id) => id === 'Structure' && refreshStructure());
  ide.on('interpreterChanged', () => { outline = null; refreshStructure(); });

  ide.registerTreeAction({ title: tr('Find in Files…'), hint: 'Ctrl+Shift+F', when: (e) => e.dir, run: (e) => openFindDialog(false, e.path) });
  ide.registerTreeAction({ title: tr('Replace in Files…'), hint: 'Ctrl+Shift+R', when: (e) => e.dir, run: (e) => openFindDialog(true, e.path) });

  [
    { id: 'FindInPath', title: tr('Find in Files…'), keys: 'Ctrl+Shift+F', run: () => openFindDialog(false) },
    { id: 'ReplaceInPath', title: tr('Replace in Files…'), keys: 'Ctrl+Shift+R', run: () => openFindDialog(true) },
    { id: 'RecentFiles', title: tr('Recent Files'), keys: 'Ctrl+E', run: showRecentFiles },
    { id: 'RecentLocations', title: tr('Recent Locations'), keys: 'Ctrl+Shift+E', run: showRecentLocations },
    { id: 'Back', title: tr('Navigate Back'), keys: 'Ctrl+Alt+ArrowLeft', run: () => navigate(back, fwd) },
    { id: 'Forward', title: tr('Navigate Forward'), keys: 'Ctrl+Alt+ArrowRight', run: () => navigate(fwd, back) },
    { id: 'JumpToLastChange', title: tr('Last Edit Location'), keys: 'Ctrl+Shift+Backspace', run: lastEdit },
    { id: 'FileStructurePopup', title: tr('File Structure'), keys: 'Ctrl+F12', run: fileStructurePopup },
    { id: 'GotoClass', title: tr('Go to Class…'), keys: 'Ctrl+N', run: () => gotoSymbol(true) },
    { id: 'GotoSymbol', title: tr('Go to Symbol…'), keys: 'Ctrl+Alt+Shift+N', run: () => gotoSymbol(false) },
    { id: 'ActivateFindToolWindow', title: tr('Tool Window: {title}', { title: tr('Find in Files') }), run: () => findTw.show() },
    { id: 'ActivateTODOToolWindow', title: tr('Tool Window: {title}', { title: 'TODO' }), run: () => { todoTw.show(); refreshTodosNow(); } },
  ].forEach(ide.registerAction);
})();
