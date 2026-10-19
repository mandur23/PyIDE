(() => {
  const { el, basename, dirname, samePath, isUnder } = ide.util;
  const monaco = ide.monaco;
  const { MouseTargetType, TrackedRangeStickiness } = monaco.editor;
  const key = (p) => p.toLowerCase();

  // ---------- breakpoints ----------
  let bps = new Map(); // pathLower -> {path, items: [{line, condition, enabled}]}
  const bpDecos = new Map(); // pathLower -> [{id, bp}]
  let saveTimer = null;

  const bpSettingsKey = () => `debugger.breakpoints:${ide.root}`;
  const watchSettingsKey = () => `debugger.watches:${ide.root}`;
  const fileBps = (path) => bps.get(key(path))?.items || [];
  const allBps = () => [...bps.values()].flatMap((f) => f.items.map((bp) => ({ path: f.path, bp })));
  const findBp = (path, line) => fileBps(path).find((b) => b.line === line);

  function loadBps() {
    bps = new Map();
    for (const b of ide.settings.get(bpSettingsKey(), [])) {
      if (!bps.has(key(b.path))) bps.set(key(b.path), { path: b.path, items: [] });
      bps.get(key(b.path)).items.push({ line: b.line, condition: b.condition || '', enabled: b.enabled !== false });
    }
  }
  function saveBps() {
    clearTimeout(saveTimer);
    saveTimer = null;
    if (!ide.root) return;
    ide.settings.set(bpSettingsKey(), allBps().map(({ path, bp }) => ({ path, line: bp.line, condition: bp.condition, enabled: bp.enabled })));
  }
  const saveBpsSoon = () => { clearTimeout(saveTimer); saveTimer = setTimeout(saveBps, 300); };

  function renderBps(path) {
    const tab = ide.findTab(path);
    if (!tab?.model || tab.model.isDisposed()) return;
    const old = (bpDecos.get(key(path)) || []).map((d) => d.id);
    const items = fileBps(path);
    const ids = tab.model.deltaDecorations(old, items.map((bp) => ({
      range: new monaco.Range(bp.line, 1, bp.line, 1),
      options: {
        isWholeLine: true,
        className: bp.enabled ? 'dbg-bp-line' : null,
        glyphMarginClassName: `dbg-bp${bp.condition ? ' cond' : ''}${bp.enabled ? '' : ' disabled'}`,
        glyphMarginHoverMessage: { value: `Line ${bp.line} in ${basename(path)}${bp.condition ? `\n\nCondition: \`${bp.condition}\`` : ''}${bp.enabled ? '' : ' (disabled)'}` },
        stickiness: TrackedRangeStickiness.NeverGrowsWhenTypingAtEdges,
      },
    })));
    bpDecos.set(key(path), ids.map((id, i) => ({ id, bp: items[i] })));
  }

  // Breakpoint lines follow edits through their decorations.
  function syncLinesFromModel(tab) {
    const decos = bpDecos.get(key(tab.path));
    if (!decos?.length) return;
    let moved = false;
    for (const { id, bp } of decos) {
      const r = tab.model.getDecorationRange(id);
      if (r && r.startLineNumber !== bp.line) { bp.line = r.startLineNumber; moved = true; }
    }
    if (!moved) return;
    const f = bps.get(key(tab.path));
    const seen = new Set();
    const before = f.items.length;
    f.items = f.items.filter((b) => !seen.has(b.line) && seen.add(b.line));
    if (f.items.length !== before) renderBps(tab.path);
    saveBpsSoon();
    sendBps(tab.path);
    bpListChanged();
  }

  function setBp(path, line, props) {
    if (!bps.has(key(path))) bps.set(key(path), { path, items: [] });
    const f = bps.get(key(path));
    let bp = f.items.find((b) => b.line === line);
    if (!bp) f.items.push((bp = { line, condition: '', enabled: true }));
    Object.assign(bp, props);
    afterBpChange(path);
    return bp;
  }
  function removeBp(path, line) {
    const f = bps.get(key(path));
    if (!f) return;
    f.items = f.items.filter((b) => b.line !== line);
    if (!f.items.length) bps.delete(key(path));
    afterBpChange(path);
  }
  function afterBpChange(path) {
    renderBps(path);
    saveBps();
    sendBps(path);
    bpListChanged();
  }
  const toggleBp = (path, line) => (findBp(path, line) ? removeBp(path, line) : setBp(path, line, {}));

  let bpListener = null;
  const bpListChanged = () => bpListener?.();

  function bpPayload(path) {
    const lines = fileBps(path).filter((b) => b.enabled).map((b) => ({ line: b.line, ...(b.condition ? { condition: b.condition } : {}) }));
    if (sess?.tempBp && samePath(sess.tempBp.path, path) && !lines.some((l) => l.line === sess.tempBp.line)) lines.push({ line: sess.tempBp.line });
    return { path, lines };
  }
  function sendBps(path) {
    if (!sess?.id) return;
    const { lines } = bpPayload(path);
    req('setBreakpoints', { source: { path }, breakpoints: lines }).catch(() => {});
  }

  // ---------- editor gutter ----------
  let hoverIds = [];
  const clearHover = () => { if (ide.editor.getModel()) hoverIds = ide.editor.getModel().deltaDecorations(hoverIds, []); };
  const activeFile = () => { const t = ide.activeTab(); return t?.kind === 'file' ? t : null; };

  ide.editor.onMouseDown((e) => {
    if (e.target.type !== MouseTargetType.GUTTER_GLYPH_MARGIN || !e.event.leftButton || !e.target.position) return;
    const tab = activeFile();
    if (!tab) return;
    clearHover();
    toggleBp(tab.path, e.target.position.lineNumber);
  });
  ide.editor.onContextMenu((e) => {
    if (e.target.type !== MouseTargetType.GUTTER_GLYPH_MARGIN || !e.target.position) return;
    const tab = activeFile();
    const bp = tab && findBp(tab.path, e.target.position.lineNumber);
    if (bp) editBpPopup(tab.path, bp);
  });
  ide.editor.onMouseMove((e) => {
    const model = ide.editor.getModel();
    const tab = activeFile();
    if (!model || !tab) return;
    const line = e.target.type === MouseTargetType.GUTTER_GLYPH_MARGIN ? e.target.position?.lineNumber : null;
    hoverIds = model.deltaDecorations(hoverIds, line && !findBp(tab.path, line)
      ? [{ range: new monaco.Range(line, 1, line, 1), options: { glyphMarginClassName: 'dbg-bp hover' } }] : []);
  });
  ide.editor.onMouseLeave(clearHover);

  // PyCharm's breakpoint popup: enabled flag and condition.
  function editBpPopup(path, bp) {
    const body = el('div');
    const enabledRow = el('label', 'dbg-check');
    const enabled = el('input');
    enabled.type = 'checkbox';
    enabled.checked = bp.enabled;
    enabledRow.append(enabled, el('span', null, 'Enabled'));
    const condRow = el('div', 'field');
    const cond = el('input');
    cond.id = 'dbgBpCondition';
    cond.placeholder = 'Python expression, e.g. i == 3';
    cond.value = bp.condition;
    condRow.append(el('label', null, 'Condition:'), cond);
    body.append(enabledRow, condRow);
    const line = bp.line;
    ide.ui.dialog({
      title: `${basename(path)}:${line}`,
      body,
      width: 460,
      buttons: [
        { label: 'Remove', run: () => removeBp(path, line) },
        { label: 'Done', primary: true, run: () => setBp(path, line, { enabled: enabled.checked, condition: cond.value.trim() }) },
      ],
    });
    setTimeout(() => cond.focus());
  }

  // ---------- session ----------
  let lastActive = false; // last value sent as 'debugSessionChanged'
  let sess = null; // {id, file, state: 'starting'|'running'|'suspended', threadId, frames, frameIdx, tempBp}
  let earlyEvents = [];
  const req = (command, args) => ide.api.invoke('debug:request', sess.id, command, args);
  const suspended = () => sess?.state === 'suspended';

  ide.api.on('debug:event', (m) => {
    if (sess && !sess.id) { earlyEvents.push(m); return; }
    if (sess && m.id === sess.id) handleEvent(m.event, m.body);
  });

  function handleEvent(event, body) {
    if (event === 'stopped') onStopped(body);
    else if (event === 'continued') setRunning();
    else if (event === 'output') {
      if (body.category === 'telemetry') return;
      con.append(body.output, body.category === 'stderr' ? 'err' : body.category === 'stdout' ? null : 'sys');
    } else if (event === 'terminated' || event === 'exited' || event === 'closed') {
      if (sess) setRunning();
    }
  }

  // cfg (from a run configuration): {interp?, cwd?, params?, env?}
  async function debugFile(file, cfg = {}) {
    if (!file) return;
    const interp = cfg.interp || ide.currentInterp();
    tw.show();
    showSub('console');
    if (!interp) return con.append('No Python interpreter found.\n', 'err');
    if (sess) await stopDebug();
    await ide.saveAll();
    lastFile = file;
    lastCfg = cfg;
    con.clear();
    con.append(`${[interp.cmd, ...interp.args].join(' ')} -m debugpy ${[file, ...(cfg.params || [])].join(' ')}\n`, 'sys');
    sess = { id: null, file, state: 'starting', frames: [], frameIdx: 0 };
    earlyEvents = [];
    const mine = sess;
    updateControls();
    const files = [...bps.values()].map((f) => bpPayload(f.path)).filter((p) => p.lines.length);
    let id;
    try {
      const opts = { params: cfg.params || [], env: cfg.env || {}, roots: ide.root ? [ide.root] : [] };
      ({ id } = await ide.api.invoke('debug:start', interp, file, cfg.cwd || dirname(file), files, opts));
    } catch (err) {
      con.append(`${String(err.message || err).replace(/^Error invoking remote method '[^']+': (Error: )?/, '')}\n`, 'err');
      if (sess === mine) { sess = null; updateControls(); }
      return;
    }
    if (sess !== mine) {
      // Stopped or superseded while debugpy was starting: tear this debuggee down instead of leaving it running unseen.
      ide.proc.attach(id, {}); // drop its buffered and future output
      ide.api.invoke('debug:stop', id).catch(() => {});
      return;
    }
    sess.id = id;
    if (sess.state === 'starting') sess.state = 'running';
    con.append('Connected to pydev debugger (build debugpy)\n', 'sys');
    con.input.disabled = false;
    updateControls();
    ide.proc.attach(id, {
      data: (text, stream) => con.append(text, stream === 'err' ? 'err' : null),
      exit: (code) => endSession(mine, code),
    });
    const queued = earlyEvents.filter((m) => m.id === id);
    earlyEvents = [];
    for (const m of queued) handleEvent(m.event, m.body);
  }

  function endSession(s, code) {
    if (sess !== s) return;
    con.append(`\nProcess finished with exit code ${code ?? 1}\n`, 'sys');
    sess = null;
    con.input.disabled = true;
    clearFrameDecorations();
    renderFrames();
    renderVars([]);
    renderWatches();
    updateControls();
  }

  async function stopDebug() {
    if (!sess) return;
    const s = sess;
    if (s.id) await ide.api.invoke('debug:stop', s.id);
    // Still starting: end the session now; debugFile stops the process as soon as 'debug:start' hands back its id.
    else endSession(s, null);
  }

  function setRunning() {
    if (!sess) return;
    sess.state = 'running';
    sess.frames = [];
    clearFrameDecorations();
    renderFrames();
    renderVars(null);
    renderWatches();
    updateControls();
  }

  async function onStopped(body) {
    sess.state = 'suspended';
    sess.threadId = body.threadId ?? sess.threadId ?? 1;
    sess.stopReason = body.reason;
    if (sess.tempBp) {
      const p = sess.tempBp.path;
      sess.tempBp = null;
      sendBps(p);
    }
    updateControls();
    const s = sess;
    let frames = [];
    try { ({ stackFrames: frames } = await req('stackTrace', { threadId: s.threadId, startFrame: 0, levels: 200 })); } catch {}
    if (sess !== s || s.state !== 'suspended') return;
    s.frames = frames;
    if (!tw.isVisible()) tw.show();
    showSub('debugger');
    renderFrames();
    await selectFrame(Math.max(0, frames.findIndex((f) => f.source?.path)));
  }

  async function selectFrame(i) {
    if (!suspended()) return;
    const s = sess;
    s.frameIdx = i;
    renderFrames();
    const frame = s.frames[i];
    if (!frame) return;
    if (frame.source?.path) await ide.openFile(frame.source.path, { line: frame.line, focus: false });
    let vars = [];
    let scopes = [];
    try {
      ({ scopes } = await req('scopes', { frameId: frame.id }));
      if (scopes[0]) ({ variables: vars } = await req('variables', { variablesReference: scopes[0].variablesReference }));
    } catch {}
    if (sess !== s || s.frameIdx !== i || !suspended()) return;
    s.locals = vars;
    s.scopes = scopes;
    applyFrameDecorations();
    renderVars(vars, scopes.slice(1));
    renderWatches();
  }

  const currentFrame = () => (suspended() ? sess.frames[sess.frameIdx] : null);

  function step(command) {
    if (!suspended()) return;
    const threadId = sess.threadId;
    setRunning();
    req(command, { threadId }).catch((err) => con.append(`${command} failed: ${err.message}\n`, 'err'));
  }
  const pause = () => sess?.state === 'running' && req('pause', { threadId: sess.threadId || 1 }).catch(() => {});

  function runToCursor() {
    const tab = activeFile();
    if (!suspended() || !tab) return;
    sess.tempBp = { path: tab.path, line: ide.editor.getPosition().lineNumber };
    sendBps(tab.path);
    step('continue');
  }

  // ---------- editor decorations while suspended ----------
  let frameDecos = []; // [{model, ids}]
  function clearFrameDecorations() {
    for (const d of frameDecos) if (!d.model.isDisposed()) d.model.deltaDecorations(d.ids, []);
    frameDecos = [];
  }

  function applyFrameDecorations() {
    clearFrameDecorations();
    const frame = currentFrame();
    const tab = frame?.source?.path && ide.findTab(frame.source.path);
    if (!tab?.model) return;
    const model = tab.model;
    const top = sess.frameIdx === 0;
    const decos = [{
      range: new monaco.Range(frame.line, 1, frame.line, 1),
      options: {
        isWholeLine: true,
        className: top ? 'dbg-exec-line' : 'dbg-frame-line',
        linesDecorationsClassName: top ? 'dbg-exec-arrow' : 'dbg-frame-arrow',
        zIndex: 10,
        stickiness: TrackedRangeStickiness.NeverGrowsWhenTypingAtEdges,
      },
    }, ...inlineValueDecorations(model, frame, sess.locals || [])];
    frameDecos.push({ model, ids: model.deltaDecorations([], decos) });
  }

  const SKIP_TYPES = new Set(['function', 'module', 'type', 'builtin_function_or_method', 'method']);
  const PY_KEYWORDS = new Set('False None True and as assert async await break class continue def del elif else except finally for from global if import in is lambda nonlocal not or pass raise return try while with yield print'.split(' '));

  // PyCharm-style inline values: "name: value" after each line (up to the execution line) that mentions a local.
  function inlineValueDecorations(model, frame, vars) {
    const byName = new Map(vars.filter((v) => /^[A-Za-z_]\w*$/.test(v.name) && !SKIP_TYPES.has(v.type)).map((v) => [v.name, v]));
    if (!byName.size) return [];
    const stop = Math.min(frame.line, model.getLineCount());
    const indent = (l) => model.getLineContent(l).search(/\S/);
    const stopIndent = indent(stop);
    let start = Math.max(1, stop - 300);
    for (let l = stop; l >= start; l--) {
      const t = model.getLineContent(l);
      if (/^\s*(async\s+)?def\s/.test(t) && t.search(/\S/) < stopIndent) { start = l; break; }
    }
    const out = [];
    for (let l = start; l <= stop; l++) {
      const code = model.getLineContent(l).replace(/(["'])(?:\\.|(?!\1).)*\1/g, '""').replace(/#.*/, '');
      if (frame.name === '<module>' && /^\s/.test(code)) continue;
      const names = [];
      for (const m of code.matchAll(/(^|[^.\w])([A-Za-z_]\w*)/g)) {
        const n = m[2];
        if (byName.has(n) && !PY_KEYWORDS.has(n) && !names.includes(n)) names.push(n);
      }
      if (!names.length) continue;
      const text = names.map((n) => `${n}: ${clip(byName.get(n).value, 50)}`).join('   ');
      const col = model.getLineMaxColumn(l);
      out.push({ range: new monaco.Range(l, col, l, col), options: { after: { content: `    ${text}`, inlineClassName: 'dbg-inline-val' }, showIfCollapsed: true } });
    }
    return out;
  }
  const clip = (s, n) => { s = String(s ?? '').replace(/\s+/g, ' '); return s.length > n ? `${s.slice(0, n - 1)}…` : s; };

  ide.on('fileOpened', (tab) => {
    renderBps(tab.path);
    tab.model.onDidChangeContent(() => syncLinesFromModel(tab));
    if (suspended() && samePath(currentFrame()?.source?.path, tab.path)) applyFrameDecorations();
  });
  ide.on('fileClosed', (path) => {
    bpDecos.delete(key(path));
    frameDecos = frameDecos.filter((d) => !d.model.isDisposed());
  });
  ide.on('projectOpened', () => {
    loadBps();
    bpDecos.clear();
    for (const t of ide.tabs) if (t.kind === 'file') renderBps(t.path);
    loadWatches();
    renderWatches();
    bpListChanged();
  });
  ide.on('filesChanged', ({ renamed, deleted }) => {
    let changed = false;
    for (const [from, to] of renamed || []) {
      for (const f of [...bps.values()]) {
        if (!isUnder(f.path, from)) continue;
        bps.delete(key(f.path));
        f.path = to + f.path.slice(from.length);
        bps.set(key(f.path), f);
        changed = true;
      }
    }
    for (const d of deleted || []) {
      for (const f of [...bps.values()]) if (isUnder(f.path, d)) { bps.delete(key(f.path)); changed = true; }
    }
    if (changed) { saveBps(); bpListChanged(); }
  });

  // ---------- variables tree ----------
  const expandedVars = new Set(); // "parent/child" paths kept open across steps, like PyCharm
  const valueClass = (v) => (v.type === 'str' ? 'str' : ['int', 'float', 'complex', 'bool'].includes(v.type) ? 'num' : '');

  function varNode(v, parentPath, depth) {
    const nodePath = `${parentPath}/${v.name}`;
    const wrap = el('div', 'dbg-node');
    const row = el('div', 'dbg-var');
    row.style.paddingLeft = `${depth * 16 + 4}px`;
    const expandable = v.variablesReference > 0;
    const arrow = el('span', 'dbg-arrow', expandable ? '▸' : '');
    row.append(arrow, el('span', 'dbg-name', v.name));
    if (v.error) row.append(el('span', 'dbg-eq', ' = '), el('span', 'dbg-err', v.error));
    // Scopes and debugpy's "special variables"/"function variables" buckets have no value of their own.
    else if (v.group || (expandable && !v.type && !v.value)) row.classList.add('dbg-group');
    else {
      row.append(el('span', 'dbg-eq', ' = '));
      if (v.type) row.append(el('span', 'dbg-type', `{${v.type}} `));
      row.append(el('span', `dbg-value ${valueClass(v)}`, v.value ?? ''));
    }
    row.title = `${v.name} = ${v.value ?? v.error ?? ''}`;
    wrap.appendChild(row);
    if (!expandable) return wrap;
    const kids = el('div', 'dbg-kids hidden');
    wrap.appendChild(kids);
    let loaded = false;
    const s = sess;
    const toggle = async (open = kids.classList.contains('hidden')) => {
      kids.classList.toggle('hidden', !open);
      arrow.textContent = open ? '▾' : '▸';
      if (open) expandedVars.add(nodePath); else expandedVars.delete(nodePath);
      if (!open || loaded || sess !== s || !suspended()) return;
      loaded = true;
      kids.appendChild(el('div', 'dbg-var muted', 'Collecting data…')).style.paddingLeft = `${depth * 16 + 24}px`;
      let children = [];
      try { ({ variables: children } = await req('variables', { variablesReference: v.variablesReference })); } catch {}
      kids.replaceChildren(...children.map((c) => varNode(c, nodePath, depth + 1)));
    };
    row.onclick = () => toggle();
    if (expandedVars.has(nodePath)) toggle(true);
    return wrap;
  }

  let varsList, framesList, watchesList, threadLabel;

  // vars: null while running, [] when no session
  function renderVars(vars, extraScopes = []) {
    if (!varsList) return;
    if (!vars) return varsList.replaceChildren(el('div', 'dbg-empty', sess ? 'Variables are not available while running' : 'Not suspended'));
    if (!sess) return varsList.replaceChildren(el('div', 'dbg-empty', 'Not debugging. Start with Shift+F9'));
    varsList.replaceChildren(
      ...vars.map((v) => varNode(v, 'L', 0)),
      ...extraScopes.map((sc) => varNode({ name: sc.name, group: true, variablesReference: sc.variablesReference }, 'S', 0)),
    );
    if (!vars.length && !extraScopes.length) varsList.appendChild(el('div', 'dbg-empty', 'No variables'));
  }

  function renderFrames() {
    if (!framesList) return;
    threadLabel.textContent = !sess ? '' : suspended() ? `MainThread · ${sess.stopReason || 'paused'}` : 'Running';
    if (!suspended()) {
      return framesList.replaceChildren(el('div', 'dbg-empty', sess ? 'Frames are not available in non-suspended state' : 'Not debugging'));
    }
    framesList.replaceChildren(...sess.frames.map((f, i) => {
      const row = el('div', 'dbg-frame' + (i === sess.frameIdx ? ' selected' : '') + (f.source?.path ? '' : ' muted'));
      row.append(el('span', 'dbg-frame-name', f.name), el('span', 'dbg-frame-loc', `, ${f.source?.path ? basename(f.source.path) : f.source?.name || '?'}:${f.line}`));
      row.title = f.source?.path || '';
      row.onclick = () => selectFrame(i);
      return row;
    }));
  }

  // ---------- watches ----------
  let watches = [];
  let selectedWatch = -1;
  const loadWatches = () => { watches = [...ide.settings.get(watchSettingsKey(), [])]; selectedWatch = -1; };
  const saveWatches = () => ide.root && ide.settings.set(watchSettingsKey(), watches);

  async function evaluate(expression, context) {
    const frame = currentFrame();
    const s = sess;
    try {
      const r = await req('evaluate', { expression, frameId: frame?.id, context });
      return { name: expression, value: r.result, type: r.type, variablesReference: r.variablesReference || 0, s };
    } catch (err) {
      return { name: expression, error: String(err.message || err).replace(/^Error invoking remote method '[^']+': (Error: )?/, ''), variablesReference: 0, s };
    }
  }

  let watchSeq = 0;
  async function renderWatches() {
    if (!watchesList) return;
    const my = ++watchSeq;
    const results = suspended() && currentFrame()
      ? await Promise.all(watches.map((w) => evaluate(w, 'watch')))
      : watches.map((w) => ({ name: w, value: '', variablesReference: 0, pending: true }));
    if (my !== watchSeq) return;
    watchesList.replaceChildren(...results.map((r, i) => {
      const node = r.pending ? (() => {
        const n = el('div', 'dbg-node');
        const row = el('div', 'dbg-var');
        row.style.paddingLeft = '4px';
        row.append(el('span', 'dbg-arrow'), el('span', 'dbg-name', r.name), el('span', 'dbg-eq muted', sess ? '  (not suspended)' : ''));
        n.appendChild(row);
        return n;
      })() : varNode(r, 'W', 0);
      node.classList.add('dbg-watch');
      node.classList.toggle('selected', i === selectedWatch);
      node.firstChild.addEventListener('mousedown', () => { selectedWatch = i; watchesList.querySelectorAll('.dbg-watch').forEach((w, j) => w.classList.toggle('selected', j === i)); });
      const del = el('button', 'dbg-watch-del', '×');
      del.title = 'Remove Watch';
      del.onclick = (e) => { e.stopPropagation(); removeWatch(i); };
      node.firstChild.appendChild(del);
      return node;
    }));
    if (!watches.length) watchesList.appendChild(el('div', 'dbg-empty', 'No watches. Add one with +'));
  }

  function addWatch(expr) {
    expr = (expr || '').trim();
    if (!expr) return;
    watches.push(expr);
    saveWatches();
    renderWatches();
  }
  function removeWatch(i = selectedWatch) {
    if (i < 0 || i >= watches.length) return;
    watches.splice(i, 1);
    selectedWatch = Math.min(selectedWatch, watches.length - 1);
    saveWatches();
    renderWatches();
  }

  // ---------- evaluate (Alt+F8) ----------
  function evaluateDialog() {
    if (!suspended()) return;
    const body = el('div', 'dbg-eval-dialog');
    const input = el('input', 'input dbg-eval-input');
    input.id = 'dbgEvalInput';
    input.placeholder = 'Expression (Enter to evaluate)';
    const sel = ide.editor.getSelection();
    const model = ide.editor.getModel();
    if (model && sel && !sel.isEmpty()) input.value = model.getValueInRange(sel);
    else if (model && sel) input.value = model.getWordAtPosition(sel.getPosition())?.word || '';
    const result = el('div', 'dbg-eval-result');
    result.id = 'dbgEvalResult';
    body.append(input, result);
    ide.ui.dialog({
      title: 'Evaluate',
      body,
      width: 620,
      buttons: [
        { label: 'Add Watch', run: () => { addWatch(input.value); return false; } },
        { label: 'Close' },
        { label: 'Evaluate', primary: true, run: async () => {
          const expr = input.value.trim();
          if (!expr) return false;
          const r = await evaluate(expr, 'repl');
          result.replaceChildren(varNode({ ...r, name: 'result' }, `E/${expr}`, 0));
          input.select();
          return false;
        } },
      ],
    });
    setTimeout(() => { input.focus(); input.select(); });
  }

  // ---------- breakpoints dialog (Ctrl+Shift+F8) ----------
  function breakpointsDialog() {
    const body = el('div', 'dbg-bps');
    const list = el('div', 'dbg-bps-list');
    list.id = 'dbgBpList';
    const detail = el('div', 'dbg-bps-detail');
    body.append(list, detail);
    let current = null;
    let dlg;
    const render = () => {
      const entries = allBps().sort((a, b) => a.path.localeCompare(b.path) || a.bp.line - b.bp.line);
      if (current && !entries.some((e) => e.bp === current.bp)) current = null;
      current ||= entries[0] || null;
      list.replaceChildren(el('div', 'dbg-bps-group', `Python Line Breakpoints (${entries.length})`), ...entries.map((e) => {
        const row = el('div', 'dbg-bps-row' + (e === current || e.bp === current?.bp ? ' selected' : ''));
        const cb = el('input');
        cb.type = 'checkbox';
        cb.checked = e.bp.enabled;
        cb.onclick = (ev) => { ev.stopPropagation(); setBp(e.path, e.bp.line, { enabled: cb.checked }); };
        row.append(cb, el('span', 'dbg-bp-dot' + (e.bp.condition ? ' cond' : '') + (e.bp.enabled ? '' : ' disabled')),
          el('span', null, `${basename(e.path)}:${e.bp.line}`), el('span', 'muted', e.bp.condition ? `  [${e.bp.condition}]` : ''));
        row.onclick = () => { current = e; render(); };
        row.ondblclick = () => { dlg.close(); ide.openFile(e.path, { line: e.bp.line }); };
        return row;
      }));
      if (!entries.length) list.appendChild(el('div', 'dbg-empty', 'No breakpoints'));
      detail.replaceChildren();
      if (!current) return;
      const { path, bp } = current;
      detail.append(el('div', 'dbg-bps-title', `${ide.util.rel(path)}:${bp.line}`));
      const en = el('label', 'dbg-check');
      const enCb = el('input');
      enCb.type = 'checkbox';
      enCb.checked = bp.enabled;
      enCb.onchange = () => setBp(path, bp.line, { enabled: enCb.checked });
      en.append(enCb, el('span', null, 'Enabled'));
      const cond = el('input', 'input');
      cond.id = 'dbgBpListCondition';
      cond.placeholder = 'Condition';
      cond.value = bp.condition;
      cond.onchange = () => setBp(path, bp.line, { condition: cond.value.trim() });
      const actions = el('div', 'dbg-bps-actions');
      const go = el('button', 'secondary', 'Go to Source');
      go.onclick = () => { dlg.close(); ide.openFile(path, { line: bp.line }); };
      const rm = el('button', 'secondary', 'Remove');
      rm.id = 'dbgBpRemove';
      rm.onclick = () => removeBp(path, bp.line);
      actions.append(go, rm);
      detail.append(en, el('div', 'muted', 'Condition:'), cond, actions);
    };
    bpListener = render;
    render();
    dlg = ide.ui.dialog({
      title: 'Breakpoints',
      body,
      width: 720,
      buttons: [{ label: 'Done', primary: true, run: () => { document.activeElement?.blur?.(); } }],
      onClose: () => { if (bpListener === render) bpListener = null; },
    });
  }

  // ---------- tool window ----------
  let con, tw, subTabs, subPanes, lastFile = null, lastCfg = {};
  const btns = {};

  function showSub(which) {
    for (const [k, b] of Object.entries(subTabs)) b.classList.toggle('active', k === which);
    for (const [k, p] of Object.entries(subPanes)) p.classList.toggle('hidden', k !== which);
  }

  function pane(title, actions = []) {
    const p = el('div', 'dbg-pane');
    const head = el('div', 'dbg-pane-head');
    const label = el('span', null, title);
    head.appendChild(label);
    head.appendChild(el('span', 'spacer'));
    for (const a of actions) {
      const b = el('button', 'dbg-mini', a.icon);
      b.title = a.title;
      b.onclick = a.run;
      if (a.id) b.id = a.id;
      head.appendChild(b);
    }
    const list = el('div', 'dbg-list');
    p.append(head, list);
    return { p, head, label, list };
  }

  tw = ide.registerToolWindow({
    id: 'Debug', title: 'Debug', icon: '🐞', side: 'bottom', keys: 'Alt+5', order: 15,
    mount(container) {
      container.classList.add('dbg-root');
      const bar = el('div', 'dbg-bar');
      subTabs = { debugger: el('button', 'dbg-subtab', 'Threads & Variables'), console: el('button', 'dbg-subtab', 'Console') };
      subTabs.debugger.id = 'dbgTabVars';
      subTabs.console.id = 'dbgTabConsole';
      subTabs.debugger.onclick = () => showSub('debugger');
      subTabs.console.onclick = () => { showSub('console'); con.input.focus(); };
      bar.append(subTabs.debugger, subTabs.console, el('span', 'dbg-sep'));
      const mk = (id, icon, title, run, cls = '') => {
        const b = el('button', `dbg-btn ${cls}`, icon);
        b.id = `dbg${id}`;
        b.title = title;
        b.onclick = run;
        bar.appendChild(b);
        btns[id] = b;
      };
      mk('Rerun', '↻', 'Rerun', () => debugFile(sess?.file || lastFile, lastCfg), 'green');
      mk('Resume', '▶', 'Resume Program (F9)', () => step('continue'), 'green');
      mk('Pause', '⏸', 'Pause Program', pause);
      mk('Stop', '■', 'Stop (Ctrl+F2)', stopDebug, 'red');
      bar.appendChild(el('span', 'dbg-sep'));
      mk('StepOver', '↷', 'Step Over (F8)', () => step('next'), 'blue');
      mk('StepInto', '↘', 'Step Into (F7)', () => step('stepIn'), 'blue');
      mk('StepOut', '↖', 'Step Out (Shift+F8)', () => step('stepOut'), 'blue');
      mk('RunToCursor', '⇥', 'Run to Cursor (Alt+F9)', runToCursor, 'blue');
      bar.appendChild(el('span', 'dbg-sep'));
      mk('Evaluate', '⌨', 'Evaluate Expression (Alt+F8)', evaluateDialog);
      mk('Breakpoints', '●', 'View Breakpoints (Ctrl+Shift+F8)', breakpointsDialog, 'red');

      const vars = el('div', 'dbg-panes');
      const frames = pane('Frames');
      threadLabel = el('span', 'dbg-thread muted');
      frames.head.insertBefore(threadLabel, frames.head.children[1]);
      framesList = frames.list;
      framesList.id = 'dbgFrames';
      const variables = pane('Variables');
      varsList = variables.list;
      varsList.id = 'dbgVars';
      const watchPane = pane('Watches', [
        { id: 'dbgWatchAdd', icon: '+', title: 'New Watch', run: () => { watchInput.classList.remove('hidden'); watchInput.focus(); } },
        { id: 'dbgWatchRemove', icon: '−', title: 'Remove Watch (Delete)', run: () => removeWatch() },
      ]);
      watchesList = watchPane.list;
      watchesList.id = 'dbgWatches';
      watchesList.tabIndex = 0;
      watchesList.onkeydown = (e) => { if (e.key === 'Delete') { e.preventDefault(); removeWatch(); } };
      const watchInput = el('input', 'dbg-watch-input hidden');
      watchInput.id = 'dbgWatchInput';
      watchInput.placeholder = 'Expression to watch (Enter)';
      watchInput.onkeydown = (e) => {
        if (e.key === 'Enter') { addWatch(watchInput.value); watchInput.value = ''; watchInput.classList.add('hidden'); }
        if (e.key === 'Escape') { e.stopPropagation(); watchInput.value = ''; watchInput.classList.add('hidden'); }
      };
      watchPane.p.insertBefore(watchInput, watchesList);
      vars.append(frames.p, variables.p, watchPane.p);

      const consoleHost = el('div', 'dbg-console hidden');
      con = ide.ui.console(consoleHost, {
        input: true,
        placeholder: 'stdin: type program input and press Enter',
        onInput(text) {
          if (!sess?.id) return;
          con.append(`${text}\n`, 'cmd');
          ide.proc.input(sess.id, `${text}\n`);
        },
      });
      con.out.id = 'dbgOut';
      con.input.id = 'dbgIn';
      con.input.disabled = true;
      const evalLine = el('div', 'dbg-eval-line');
      const evalIn = el('input', 'console-in');
      evalIn.id = 'dbgConsoleEval';
      evalIn.placeholder = 'Evaluate expression in the selected frame (Enter)';
      evalIn.onkeydown = async (e) => {
        if (e.key !== 'Enter') return;
        const expr = evalIn.value.trim();
        if (!expr) return;
        evalIn.value = '';
        con.append(`>>> ${expr}\n`, 'cmd');
        if (!suspended()) return con.append('Evaluation is available only while the program is suspended\n', 'err');
        const r = await evaluate(expr, 'repl');
        if (r.error) con.append(`${r.error}\n`, 'err');
        else if (r.value !== undefined && r.value !== '') con.append(`${r.value}\n`);
        refreshAfterEval();
      };
      evalLine.append(el('span', 'dbg-eval-prompt', '>>>'), evalIn);
      consoleHost.appendChild(evalLine);

      subPanes = { debugger: vars, console: consoleHost };
      container.append(bar, vars, consoleHost);
      showSub('debugger');
      renderFrames();
      renderVars([]);
    },
  });

  // Statements typed in the console may change state, so refresh the views without moving the frame.
  async function refreshAfterEval() {
    if (suspended()) await selectFrame(sess.frameIdx);
  }

  function updateControls() {
    const active = !!sess;
    const susp = suspended();
    btns.Resume.disabled = !susp;
    btns.Pause.disabled = sess?.state !== 'running';
    btns.Stop.disabled = !active;
    btns.Rerun.disabled = !(sess?.file || lastFile);
    for (const k of ['StepOver', 'StepInto', 'StepOut', 'RunToCursor', 'Evaluate']) btns[k].disabled = !susp;
    debugBtn.classList.toggle('active', active);
    tw.setBadge(susp ? '●' : '');
    if (active !== lastActive) { lastActive = active; ide.emit('debugSessionChanged', active); }
  }

  // ---------- toolbar, actions ----------
  const debugBtn = el('button', 'tb-icon dbg-tb-btn');
  debugBtn.id = 'debugBtn';
  debugBtn.title = 'Debug (Shift+F9)';
  debugBtn.innerHTML = '<svg width="16" height="16" viewBox="0 0 16 16" fill="none" stroke="currentColor" stroke-width="1.3" stroke-linecap="round">'
    + '<ellipse cx="8" cy="9.5" rx="3.6" ry="4.3"/><path d="M5.6 5.6a2.6 2.6 0 0 1 4.8 0"/><path d="M8 7v6.6"/>'
    + '<path d="M4.4 8.2H2.2M11.6 8.2h2.2M4.6 11.4l-2 1.4M11.4 11.4l2 1.4M5 6.6 3.2 5M11 6.6 12.8 5"/></svg>';
  ide.registerToolbarItem({ order: 80, el: debugBtn });

  function debugCurrent() {
    const tab = ide.activeTab();
    if (tab?.kind === 'file' && tab.path.endsWith('.py')) return debugFile(tab.path);
    if (lastFile) return debugFile(lastFile, lastCfg);
    tw.show();
    showSub('console');
    con.append('Open a .py file to debug it.\n', 'sys');
  }
  debugBtn.onclick = debugCurrent;
  updateControls();

  const hasFile = () => !!activeFile();
  [
    { id: 'Debug', title: 'Debug', keys: 'Shift+F9', run: debugCurrent },
    { id: 'ToggleLineBreakpoint', title: 'Toggle Line Breakpoint', keys: 'Ctrl+F8', when: hasFile,
      run: () => toggleBp(activeFile().path, ide.editor.getPosition().lineNumber) },
    { id: 'ViewBreakpoints', title: 'View Breakpoints…', keys: 'Ctrl+Shift+F8', run: breakpointsDialog },
    { id: 'StepOver', title: 'Step Over', keys: 'F8', when: suspended, run: () => step('next') },
    { id: 'StepInto', title: 'Step Into', keys: 'F7', when: suspended, run: () => step('stepIn') },
    { id: 'StepOut', title: 'Step Out', keys: 'Shift+F8', when: suspended, run: () => step('stepOut') },
    { id: 'Resume', title: 'Resume Program', keys: 'F9', when: suspended, run: () => step('continue') },
    { id: 'Pause', title: 'Pause Program', when: () => sess?.state === 'running', run: pause },
    { id: 'RunToCursor', title: 'Run to Cursor', keys: 'Alt+F9', when: suspended, run: runToCursor },
    { id: 'EvaluateExpression', title: 'Evaluate Expression…', keys: 'Alt+F8', when: suspended, run: evaluateDialog },
  ].forEach(ide.registerAction);
  // Registered after every feature has loaded so it takes precedence over run's Ctrl+F2, but only while debugging.
  ide.on('ready', () => ide.registerAction({ id: 'StopDebug', title: 'Stop Debugging', keys: 'Ctrl+F2', when: () => !!sess, run: stopDebug }));
  ide.registerTreeAction({ title: "Debug '…'", when: (e) => !e.dir && e.name.endsWith('.py'), run: (e) => debugFile(e.path) });

  ide.debugger = { debugFile, isActive: () => !!sess };
  window.__debugger = { state: () => sess && { id: sess.id, state: sess.state, frameIdx: sess.frameIdx, frames: sess.frames.map((f) => ({ name: f.name, line: f.line, path: f.source?.path })) }, breakpoints: () => allBps().map(({ path, bp }) => ({ path, ...bp })) };
})();
