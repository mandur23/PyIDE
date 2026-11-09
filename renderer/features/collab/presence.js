// The others in a collaboration session, in the editors: their carets, selections and name tags in their colors, and
// follow mode (open what the followed person has in front and scroll where they look). This window's own caret and
// file in front go to the others (collab:cursor, collab:view). Positions travel as op offsets (every line break one
// '\n', ide.textOffsets), so CRLF and LF windows agree; once drawn, Monaco's decorations move with every edit.
(() => {
  const { el, samePath } = ide.util;
  const C = ide.collab;
  const monaco = ide.monaco;
  if (!C || !monaco) return;
  const api = ide.api;

  // ---------- this window's caret and view ----------
  const sessionDoc = (ed) => {
    const m = ed?.getModel();
    const tab = m && ide.tabs.find((t) => t.model === m && t.kind === 'file');
    return tab && C.inSession(tab.path) ? tab : null;
  };
  let cursorTimer = null;
  let viewTimer = null;
  function sendCursor() {
    cursorTimer = null;
    if (!C.state().role) return;
    const ed = ide.editor;
    const tab = sessionDoc(ed);
    if (!tab) return api.send('collab:cursor', { path: null, ranges: [] });
    const m = tab.model;
    const ranges = (ed.getSelections() || []).slice(0, 100).map((s) => [
      ide.textOffsets.offset(m, { lineNumber: s.selectionStartLineNumber, column: s.selectionStartColumn }),
      ide.textOffsets.offset(m, { lineNumber: s.positionLineNumber, column: s.positionColumn }),
    ]);
    return api.send('collab:cursor', { path: tab.path, ranges });
  }
  function sendView() {
    viewTimer = null;
    if (!C.state().role) return;
    const ed = ide.editor;
    const tab = sessionDoc(ed);
    const line = tab ? ed.getVisibleRanges()[0]?.startLineNumber || 1 : 1;
    api.send('collab:view', { path: tab ? tab.path : null, line });
  }
  const soonCursor = () => { if (C.state().role && !cursorTimer) cursorTimer = setTimeout(sendCursor, 50); };
  const soonView = () => { if (!C.state().role) return; clearTimeout(viewTimer); viewTimer = setTimeout(sendView, 150); };
  const hooked = new WeakSet();
  function hook(ed) {
    if (!ed || hooked.has(ed)) return;
    hooked.add(ed);
    ed.onDidChangeCursorSelection(() => { if (ed === ide.editor) soonCursor(); });
    ed.onDidScrollChange((e) => { if (ed === ide.editor && e.scrollTopChanged) soonView(); });
    ed.onDidChangeModel(() => drawTags());
  }
  for (const ed of monaco.editor.getEditors()) hook(ed);
  ide.on('editorCreated', (ed) => { hook(ed); drawTags(); });
  ide.on('activeTabChanged', () => { soonCursor(); soonView(); drawTags(); });

  // ---------- the others ----------
  const cursors = new Map(); // id -> {path, ranges, at}
  const views = new Map(); // id -> {path, line}
  const drawn = new Map(); // model -> {ids: [decoration ids], carets: Map(id -> decoration id)}
  const nameOf = (id) => C.person(id)?.name ?? '';
  const colorOf = (id) => (C.person(id)?.color ?? id) % 8;
  const docFor = (path) => (path ? ide.getDocument(path) : null);

  function decorate(model) {
    const list = [];
    const owners = [];
    for (const [id, c] of cursors) {
      if (id === C.me() || !c.path) continue;
      const doc = docFor(c.path);
      if (!doc || doc.model !== model) continue;
      const color = colorOf(id);
      for (const [a, b] of c.ranges) {
        if (a === b) continue;
        const pa = ide.textOffsets.position(model, a);
        const pb = ide.textOffsets.position(model, b);
        const [s, e] = a <= b ? [pa, pb] : [pb, pa];
        list.push({ range: monaco.Range.fromPositions(s, e), options: { className: `collab-sel collab-c${color}`, stickiness: 1 } });
        owners.push(null);
      }
      if (c.ranges.length) {
        const caret = ide.textOffsets.position(model, c.ranges[0][1]);
        list.push({ range: monaco.Range.fromPositions(caret, caret), options: { beforeContentClassName: `collab-caret collab-c${color}`, stickiness: 1 } });
        owners.push(id);
      }
    }
    const prev = drawn.get(model);
    // Selections have no owner; carets do (their place moves the name tag).
    const ids = model.deltaDecorations(prev?.ids || [], list);
    const carets = new Map();
    owners.forEach((id, i) => { if (id !== null) carets.set(id, ids[i]); });
    if (!list.length) drawn.delete(model); else drawn.set(model, { ids, carets });
    if (!hookedModels.has(model)) {
      hookedModels.add(model);
      model.onDidChangeContent(() => { if (drawn.has(model)) tagsSoon(); });
      model.onWillDispose(() => drawn.delete(model));
    }
  }
  const hookedModels = new WeakSet();
  function redrawAll() {
    const models = new Set([...drawn.keys()]);
    for (const c of cursors.values()) { const d = docFor(c.path); if (d) models.add(d.model); }
    for (const m of models) if (!m.isDisposed()) decorate(m);
    drawTags();
  }

  // Name tags: a content widget per caret, in every editor that shows its document.
  const tags = new Map(); // editor -> Map(id -> widget)
  let tagTimer = null;
  const tagsSoon = () => { if (!tagTimer) tagTimer = setTimeout(() => { tagTimer = null; drawTags(); }, 30); };
  function drawTags() {
    for (const ed of monaco.editor.getEditors()) {
      const model = ed.getModel();
      const mine = tags.get(ed) || new Map();
      tags.set(ed, mine);
      const want = new Map();
      const d = model && drawn.get(model);
      if (d) for (const [id, decId] of d.carets) { const r = model.getDecorationRange(decId); if (r) want.set(id, r.getStartPosition()); }
      for (const [id, w] of mine) if (!want.has(id)) { ed.removeContentWidget(w); mine.delete(id); }
      for (const [id, pos] of want) {
        let w = mine.get(id);
        if (!w) {
          const node = el('div', `collab-tag collab-c${colorOf(id)}`, nameOf(id));
          node.dataset.id = id;
          w = { id: `collab.tag.${id}`, node, pos, getId: () => w.id, getDomNode: () => w.node, getPosition: () => ({ position: w.pos, preference: [monaco.editor.ContentWidgetPositionPreference.ABOVE, monaco.editor.ContentWidgetPositionPreference.BELOW] }) };
          mine.set(id, w);
          ed.addContentWidget(w);
        }
        w.pos = pos;
        w.node.textContent = nameOf(id);
        w.node.className = `collab-tag collab-c${colorOf(id)}${Date.now() - (cursors.get(id)?.at || 0) > 4000 ? ' quiet' : ''}`;
        ed.layoutContentWidget(w);
      }
    }
  }
  // A tag shows its name while the caret moves, then shrinks to a small mark.
  setInterval(() => { if (drawn.size) drawTags(); }, 2000);

  C.on('cursor', (e) => {
    if (!Number.isSafeInteger(e.id)) return;
    const ranges = Array.isArray(e.ranges) ? e.ranges.filter((r) => Array.isArray(r) && r.length === 2 && r.every(Number.isSafeInteger)) : [];
    if (e.path) cursors.set(e.id, { path: e.path, ranges, at: Date.now() }); else cursors.delete(e.id);
    redrawAll();
  });
  // A guest's documents arrive empty and take their text when the host answers: the carets already known are drawn then.
  ide.on('remoteDocumentSynced', () => redrawAll());
  ide.on('remoteFileOpened', () => redrawAll());
  C.on('people', () => {
    const ids = new Set(C.state().people.map((p) => p.id));
    for (const id of [...cursors.keys()]) if (!ids.has(id)) cursors.delete(id);
    if (following !== null && !ids.has(following)) follow(null);
    redrawAll();
  });

  // ---------- follow mode ----------
  let following = null;
  C.on('view', (e) => {
    if (!Number.isSafeInteger(e.id)) return;
    views.set(e.id, { path: e.path, line: Number.isSafeInteger(e.line) ? e.line : 1 });
    if (e.id === following) goTo(views.get(e.id));
  });
  async function goTo(v) {
    if (!v?.path) return;
    const tab = ide.activeTab();
    if (!tab || !samePath(tab.path, v.path)) await (C.isRemote(v.path) ? C.opened(v.path, { focus: false }) : ide.openFile(v.path, { focus: false }));
    const ed = ide.editor;
    if (ed && ide.activeTab() && samePath(ide.activeTab().path, v.path)) ed.setScrollTop(ed.getTopForLineNumber(v.line));
  }
  function follow(id) {
    following = id;
    document.body.classList.toggle('collab-following', id !== null);
    C.render();
    if (id !== null) goTo(views.get(id));
  }
  C.follow = follow;
  C.following = () => following;

  C.on('ended', () => {
    cursors.clear();
    views.clear();
    following = null;
    document.body.classList.remove('collab-following');
    for (const [m, d] of drawn) if (!m.isDisposed()) m.deltaDecorations(d.ids, []);
    drawn.clear();
    drawTags();
  });
  // A new session hears where this window is at once.
  C.on('welcome', () => { sendCursor(); sendView(); });
  C.on('started', () => { sendCursor(); sendView(); });
})();
