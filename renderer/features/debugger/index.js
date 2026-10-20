(() => {
  const { el, basename, dirname, samePath, isUnder } = ide.util;
  const monaco = ide.monaco;
  const { MouseTargetType, TrackedRangeStickiness } = monaco.editor;
  const key = (p) => p.toLowerCase();

  // ---------- breakpoints ----------
  // A breakpoint with a logMessage is a logpoint: debugpy prints the message ({expr} parts evaluated) and never suspends.
  // hitCondition is debugpy's: "3" suspends on the 3rd hit only, ">= 3" from the 3rd on, "% 3" on every 3rd.
  let bps = new Map(); // pathLower -> {path, items: [{line, condition, hitCondition, logMessage, enabled}]}
  const bpDecos = new Map(); // pathLower -> [{id, bp}]
  let saveTimer = null;

  const bpSettingsKey = () => `debugger.breakpoints:${ide.root}`;
  const watchSettingsKey = () => `debugger.watches:${ide.root}`;
  const fileBps = (path) => bps.get(key(path))?.items || [];
  const allBps = () => [...bps.values()].flatMap((f) => f.items.map((bp) => ({ path: f.path, bp })));
  const findBp = (path, line) => fileBps(path).find((b) => b.line === line);
  const newBp = (line) => ({ line, condition: '', hitCondition: '', logMessage: '', enabled: true });
  const isConditional = (bp) => !!(bp.condition || bp.hitCondition);
  const bpClasses = (bp) => `${isConditional(bp) ? ' cond' : ''}${bp.logMessage ? ' log' : ''}${bp.enabled ? '' : ' disabled'}`;

  function loadBps() {
    bps = new Map();
    for (const b of ide.settings.get(bpSettingsKey(), [])) {
      if (!bps.has(key(b.path))) bps.set(key(b.path), { path: b.path, items: [] });
      bps.get(key(b.path)).items.push({ ...newBp(b.line), condition: b.condition || '', hitCondition: b.hitCondition || '',
        logMessage: b.logMessage || '', enabled: b.enabled !== false });
    }
  }
  function saveBps() {
    clearTimeout(saveTimer);
    saveTimer = null;
    if (!ide.root) return;
    ide.settings.set(bpSettingsKey(), allBps().map(({ path, bp }) => ({ path, line: bp.line, condition: bp.condition,
      hitCondition: bp.hitCondition, logMessage: bp.logMessage, enabled: bp.enabled })));
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
        className: bp.enabled && !bp.logMessage ? 'dbg-bp-line' : null,
        glyphMarginClassName: `dbg-bp${bpClasses(bp)}`,
        glyphMarginHoverMessage: { value: bpHover(path, bp) },
        stickiness: TrackedRangeStickiness.NeverGrowsWhenTypingAtEdges,
      },
    })));
    bpDecos.set(key(path), ids.map((id, i) => ({ id, bp: items[i] })));
  }
  const code = (s) => `\`${s.replace(/`/g, "'")}\``;
  function bpHover(path, bp) {
    const parts = [`${tr('Line {line} in {file}', { line: bp.line, file: basename(path) })}${bp.enabled ? '' : ` ${tr('(disabled)')}`}`];
    if (bp.condition) parts.push(`${tr('Condition:')} ${code(bp.condition)}`);
    if (bp.hitCondition) parts.push(`${tr('Hit count:')} ${code(bp.hitCondition)}`);
    if (bp.logMessage) parts.push(`${tr('Log message:')} ${code(bp.logMessage)}`);
    return parts.join('\n\n');
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
    if (!bp) f.items.push((bp = newBp(line)));
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
    const lines = fileBps(path).filter((b) => b.enabled).map((b) => ({ line: b.line, ...(b.condition ? { condition: b.condition } : {}),
      ...(b.hitCondition ? { hitCondition: b.hitCondition } : {}), ...(b.logMessage ? { logMessage: b.logMessage } : {}) }));
    if (sess?.tempBp && samePath(sess.tempBp.path, path) && !lines.some((l) => l.line === sess.tempBp.line)) lines.push({ line: sess.tempBp.line });
    return { path, lines };
  }
  function sendBps(path) {
    if (!sess) return;
    // debug:start took its breakpoints when it was called; files changed while debugpy starts are sent once it runs.
    if (!sess.id) { sess.pendingBps.add(path); return; }
    const { lines } = bpPayload(path);
    req('setBreakpoints', { source: { path }, breakpoints: lines }).catch(() => {});
  }

  // ---------- editor gutter ----------
  const activeFile = () => { const t = ide.activeTab(); return t?.kind === 'file' ? t : null; };
  // The file shown in a given editor (a split pane or an editor embedded in a viewer).
  const pathOf = (ed) => { const m = ed.getModel(); return m ? ide.tabs.find((t) => t.model === m)?.path || null : null; };

  // Every pane gets its own glyph-margin handlers; the hover dot is an editor decoration, so it shows only in that pane.
  ide.onEditor((ed) => {
    const hover = ed.createDecorationsCollection();
    const clearHover = () => hover.clear();
    ed.onMouseDown((e) => {
      if (e.target.type !== MouseTargetType.GUTTER_GLYPH_MARGIN || !e.event.leftButton || !e.target.position) return;
      const path = pathOf(ed);
      if (!path) return;
      clearHover();
      toggleBp(path, e.target.position.lineNumber);
    });
    ed.onContextMenu((e) => {
      if (e.target.type !== MouseTargetType.GUTTER_GLYPH_MARGIN || !e.target.position) return;
      const path = pathOf(ed);
      const bp = path && findBp(path, e.target.position.lineNumber);
      if (bp) editBpPopup(path, bp, ed);
    });
    ed.onMouseMove((e) => {
      const path = pathOf(ed);
      if (!path) return;
      // No hover dot over another glyph (the run icon): adding one opens a second glyph lane and shifts that icon
      // out from under the mouse, so the click would land on the breakpoint lane instead.
      const onGlyph = e.target.element?.closest?.('.cgmr:not(.dbg-bp)');
      const line = e.target.type === MouseTargetType.GUTTER_GLYPH_MARGIN && !onGlyph ? e.target.position?.lineNumber : null;
      hover.set(line && !findBp(path, line)
        ? [{ range: new monaco.Range(line, 1, line, 1), options: { glyphMarginClassName: 'dbg-bp hover' } }] : []);
    });
    ed.onMouseLeave(clearHover);
    ed.onDidChangeModel(clearHover);
  });

  // The fields PyCharm's breakpoint popup and the Breakpoints dialog share. onChange gets the edited props.
  function bpFields(bp, onChange, ids = {}) {
    const box = el('div', 'dbg-bp-fields');
    const check = (label, checked) => {
      const row = el('label', 'dbg-check');
      const cb = el('input');
      cb.type = 'checkbox';
      cb.checked = checked;
      row.append(cb, el('span', null, label));
      return { row, cb };
    };
    const input = (id, value, placeholder) => {
      const i = el('input', 'input');
      if (id) i.id = id;
      i.value = value;
      i.placeholder = placeholder;
      i.spellcheck = false;
      return i;
    };
    const en = check(tr('Enabled'), bp.enabled);
    const cond = input(ids.condition, bp.condition, tr('Python expression, e.g. i == 3'));
    const hit = input(ids.hit, bp.hitCondition, tr('e.g. 3, >= 3 or % 3'));
    hit.classList.add('dbg-bp-hit');
    const log = check(tr('Log message instead of suspending'), !!bp.logMessage);
    const msg = input(ids.log, bp.logMessage, tr('e.g. i = {i}, total = {total}'));
    const syncLog = () => { msg.disabled = !log.cb.checked; };
    syncLog();
    const props = () => ({
      enabled: en.cb.checked,
      condition: cond.value.trim(),
      hitCondition: hit.value.trim(),
      logMessage: log.cb.checked ? msg.value.trim() : '',
    });
    log.cb.onchange = () => { syncLog(); if (log.cb.checked) msg.focus(); onChange?.(props()); };
    en.cb.onchange = () => onChange?.(props());
    for (const i of [cond, hit, msg]) i.onchange = () => onChange?.(props());
    if (ids.log) log.cb.id = `${ids.log}Toggle`;
    const field = (label, ...nodes) => { const r = el('div', 'dbg-bp-field'); r.append(el('span', 'dbg-bp-label', label), ...nodes); return r; };
    box.append(en.row, field(tr('Condition:'), cond), field(tr('Hit count:'), hit), log.row, msg,
      el('div', 'dbg-bp-hint', tr('Expressions in braces are evaluated and printed to the Debug console.')));
    return { el: box, props, focus: () => cond.focus() };
  }

  // PyCharm's inline breakpoint popup, opened by right-clicking a breakpoint or Ctrl+Shift+F8 on its line.
  // Changes apply when it closes (Enter, Esc, Done or a click elsewhere); Ctrl+Shift+F8 again opens the full dialog.
  let closeBpPopup = null;
  function editBpPopup(path, bp, ed = ide.editor) {
    closeBpPopup?.();
    const line = bp.line;
    const pop = el('div', 'dbg-bp-popup dbg-dialog');
    pop.id = 'dbgBpPopup';
    const title = el('div', 'dbg-bp-popup-title', `${basename(path)}:${line}`);
    title.dataset.userText = '';
    const fields = bpFields(bp, null, { condition: 'dbgBpCondition', hit: 'dbgBpHit', log: 'dbgBpLog' });
    const foot = el('div', 'dbg-bp-popup-foot');
    const more = el('button', 'link', withKeys(tr('More'), 'Ctrl+Shift+F8'));
    const rm = el('button', 'secondary', tr('Remove'));
    const done = el('button', 'primary', tr('Done'));
    foot.append(more, el('span', 'spacer'), rm, done);
    pop.append(title, fields.el, foot);

    let closed = false;
    const close = (apply = true) => {
      if (closed) return;
      closed = true;
      closeBpPopup = null;
      removeEventListener('keydown', onKey, true);
      removeEventListener('mousedown', outside, true);
      pop.remove();
      if (apply && findBp(path, line) === bp) setBp(path, line, fields.props());
    };
    const onKey = (e) => {
      const combo = `${e.ctrlKey ? 'Ctrl+' : ''}${e.shiftKey ? 'Shift+' : ''}${e.key}`;
      if (e.isComposing) return;
      if (e.key === 'Escape' || e.key === 'Enter' || combo === 'Ctrl+Shift+F8') {
        e.preventDefault();
        e.stopPropagation();
        close();
        if (combo === 'Ctrl+Shift+F8') breakpointsDialog({ path, line });
        else ed.focus();
      }
    };
    const outside = (e) => { if (!pop.contains(e.target)) close(); };
    more.onclick = () => { close(); breakpointsDialog({ path, line }); };
    rm.onclick = () => { close(false); removeBp(path, line); ed.focus(); };
    done.onclick = () => { close(); ed.focus(); };
    closeBpPopup = () => close();

    // Under the glyph, kept inside the window.
    ed.revealLineInCenterIfOutsideViewport(line);
    const r = ed.getDomNode().getBoundingClientRect();
    const li = ed.getLayoutInfo();
    const pos = ed.getScrolledVisiblePosition({ lineNumber: line, column: 1 });
    document.getElementById('dialogHost').appendChild(pop);
    const x = r.left + li.glyphMarginLeft + 2;
    const y = r.top + (pos ? pos.top + pos.height : 0) + 2;
    pop.style.left = `${Math.max(4, Math.min(x, innerWidth - pop.offsetWidth - 4))}px`;
    pop.style.top = `${y + pop.offsetHeight > innerHeight - 4 ? Math.max(4, y - pop.offsetHeight - (pos?.height || 0) - 4) : y}px`;
    addEventListener('keydown', onKey, true);
    setTimeout(() => { if (!closed) { addEventListener('mousedown', outside, true); fields.focus(); } });
  }

  // ---------- session ----------
  let lastActive = false; // last value sent as 'debugSessionChanged'
  let sess = null; // {id, file, state: 'starting'|'running'|'suspended', threadId, frames, frameIdx, tempBp}
  let earlyEvents = [];
  let startKeys = 0;
  const req = (command, args) => ide.api.invoke('debug:request', sess.id, command, args);
  const suspended = () => sess?.state === 'suspended';

  // Errors from main/features/debug.js arrive as English text; its own messages are translated here, while
  // debugpy's (exception text, OS errors) pass through unchanged.
  const MAIN_ERRORS = [
    [/^Could not connect to debugpy on port (\d+): ([\s\S]*)$/, (m) => tr('Could not connect to debugpy on port {port}: {error}', { port: m[1], error: m[2] })],
    [/^Debug session closed$/, () => tr('Debug session closed')],
    [/^debugpy did not start the debug session within (\d+) seconds$/, (m) => tr('debugpy did not start the debug session within {seconds} seconds', { seconds: m[1] })],
    [/^No debug session$/, () => tr('No debug session')],
    [/^(\w+) failed$/, (m) => tr('{command} failed', { command: m[1] })],
  ];
  function remoteError(err) {
    const msg = ide.util.errorText(err);
    for (const [re, fn] of MAIN_ERRORS) { const m = re.exec(msg); if (m) return fn(m); }
    return msg;
  }

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

  // cfg (from a run configuration): {interp?, cwd?, params?, env?, envFiles?} (envFiles: absolute .env paths; default the root's .env)
  async function debugFile(file, cfg = {}) {
    if (!file) return;
    const interp = cfg.interp || ide.currentInterp();
    tw.show();
    showSub('console');
    if (!interp) return con.append(`${tr('No Python interpreter found.')}\n`, 'err');
    if (sess) await stopDebug();
    if (ide.settings.get('autosave.beforeRun', true)) await ide.saveAll();
    lastFile = file;
    lastCfg = cfg;
    con.clear();
    con.append(`${[interp.cmd, ...interp.args].join(' ')} -m debugpy ${[file, ...(cfg.params || [])].join(' ')}\n`, 'sys');
    sess = { id: null, startKey: ++startKeys, file, state: 'starting', frames: [], frameIdx: 0, pendingBps: new Set() };
    earlyEvents = [];
    const mine = sess;
    updateControls();
    const files = [...bps.values()].map((f) => bpPayload(f.path)).filter((p) => p.lines.length);
    let id;
    try {
      const opts = { params: cfg.params || [], env: cfg.env || {}, envFiles: cfg.envFiles, roots: ide.root ? [ide.root] : [],
        startKey: mine.startKey };
      ({ id } = await ide.api.invoke('debug:start', interp, file, cfg.cwd || dirname(file), files, opts));
    } catch (err) {
      // A startup the user stopped (or replaced) ends quietly: the console already says the process finished.
      if (sess === mine) {
        con.append(`${remoteError(err)}\n`, 'err');
        sess = null;
        updateControls();
      }
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
    con.append(`${tr('Connected to pydev debugger (build debugpy)')}\n`, 'sys');
    con.input.disabled = false;
    updateControls();
    ide.proc.attach(id, {
      // A session replaced by a new one (Rerun) must not write into the console the new one cleared.
      data: (text, stream) => sess === mine && con.append(text, stream === 'err' ? 'err' : null),
      exit: (code) => endSession(mine, code),
    });
    for (const p of mine.pendingBps) sendBps(p);
    mine.pendingBps.clear();
    const queued = earlyEvents.filter((m) => m.id === id);
    earlyEvents = [];
    for (const m of queued) handleEvent(m.event, m.body);
  }

  function endSession(s, code) {
    if (sess !== s) return;
    con.append(`\n${tr('Process finished with exit code {code}', { code: code ?? 1 })}\n`, 'sys');
    sess = null;
    con.input.disabled = true;
    clearFrameDecorations();
    renderFrames();
    renderVars([]);
    renderWatches();
    updateControls();
    ide.emit('debugContextChanged');
  }

  async function stopDebug() {
    if (!sess) return;
    const s = sess;
    if (s.id) await ide.api.invoke('debug:stop', s.id);
    else {
      // Still starting: end the session now and have main abort the startup, which kills the debuggee even when
      // debugpy never completes the handshake (debugFile also stops it should 'debug:start' still return an id).
      endSession(s, null);
      await ide.api.invoke('debug:stop', null, s.startKey).catch(() => {});
    }
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
    ide.emit('debugContextChanged');
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
    ide.emit('debugContextChanged');
  }

  const currentFrame = () => (suspended() ? sess.frames[sess.frameIdx] : null);

  function step(command) {
    if (!suspended()) return;
    const threadId = sess.threadId;
    setRunning();
    req(command, { threadId }).catch((err) => con.append(`${tr('{command} failed: {error}', { command, error: remoteError(err) })}\n`, 'err'));
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
  // Other plugins add links to value rows (the Data View's "View as DataFrame"): fn(row, variable, expression).
  const varDecorators = [];
  const valueClass = (v) => (v.type === 'str' ? 'str' : ['int', 'float', 'complex', 'bool'].includes(v.type) ? 'num' : '');
  // Names, types, values and debugpy's error text are program data: never translated (data-user-text).
  const data = (cls, text, title) => {
    const n = el('span', cls, text);
    n.dataset.userText = '';
    if (title) n.title = title;
    return n;
  };
  // Labels debugpy gives scopes and variable buckets; anything else is shown as is.
  const GROUP_LABELS = { Locals: tr('Locals'), Globals: tr('Globals'), 'special variables': tr('special variables'),
    'function variables': tr('function variables'), 'class variables': tr('class variables'), 'protected variables': tr('protected variables') };
  const groupLabel = (name) => (Object.hasOwn(GROUP_LABELS, name) ? GROUP_LABELS[name] : name);

  function varNode(v, parentPath, depth) {
    const nodePath = `${parentPath}/${v.name}`;
    const wrap = el('div', 'dbg-node');
    const row = el('div', 'dbg-var');
    row.style.paddingLeft = `${depth * 16 + 4}px`;
    const expandable = v.variablesReference > 0;
    const arrow = el('span', 'dbg-arrow', expandable ? '▸' : '');
    // Scopes and debugpy's "special variables"/"function variables" buckets have no value of their own.
    const group = !v.error && (v.group || (expandable && !v.type && !v.value));
    const tip = `${v.name} = ${v.value ?? v.error ?? ''}`;
    if (group) {
      row.classList.add('dbg-group');
      row.append(arrow, el('span', 'dbg-name', groupLabel(v.name)));
    } else {
      row.append(arrow, v.label ? el('span', 'dbg-name', v.label) : data('dbg-name', v.name, tip));
    }
    if (v.error) row.append(el('span', 'dbg-eq', ' = '), data('dbg-err', v.error, tip));
    else if (!group) {
      row.append(el('span', 'dbg-eq', ' = '));
      if (v.type) row.append(data('dbg-type', `{${v.type}} `));
      row.append(data(`dbg-value ${valueClass(v)}`, v.value ?? '', tip));
      const expr = v.evaluateName || (parentPath === 'W' ? v.name : null);
      for (const fn of varDecorators) { try { fn(row, v, expr); } catch (err) { console.error(err); } }
    }
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
      kids.appendChild(el('div', 'dbg-var muted', tr('Collecting data…'))).style.paddingLeft = `${depth * 16 + 24}px`;
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
    if (!vars) return varsList.replaceChildren(el('div', 'dbg-empty', sess ? tr('Variables are not available while running') : tr('Not suspended')));
    if (!sess) return varsList.replaceChildren(el('div', 'dbg-empty', tr('Not debugging. Start with {keys}', { keys: 'Shift+F9' })));
    varsList.replaceChildren(
      ...vars.map((v) => varNode(v, 'L', 0)),
      ...extraScopes.map((sc) => varNode({ name: sc.name, group: true, variablesReference: sc.variablesReference }, 'S', 0)),
    );
    if (!vars.length && !extraScopes.length) varsList.appendChild(el('div', 'dbg-empty', tr('No variables')));
  }

  // DAP 'stopped' reasons, shown next to the thread name.
  const STOP_REASONS = { breakpoint: tr('breakpoint'), step: tr('step'), pause: tr('pause'), exception: tr('exception'), entry: tr('entry'),
    goto: tr('goto'), 'function breakpoint': tr('function breakpoint'), 'data breakpoint': tr('data breakpoint') };
  const stopReasonLabel = (reason) => (!reason ? tr('paused') : Object.hasOwn(STOP_REASONS, reason) ? STOP_REASONS[reason] : reason);

  function renderFrames() {
    if (!framesList) return;
    threadLabel.textContent = !sess ? '' : suspended() ? `MainThread · ${stopReasonLabel(sess.stopReason)}` : tr('Running');
    if (!suspended()) {
      return framesList.replaceChildren(el('div', 'dbg-empty', sess ? tr('Frames are not available in non-suspended state') : tr('Not debugging')));
    }
    framesList.replaceChildren(...sess.frames.map((f, i) => {
      const row = el('div', 'dbg-frame' + (i === sess.frameIdx ? ' selected' : '') + (f.source?.path ? '' : ' muted'));
      row.append(data('dbg-frame-name', f.name), data('dbg-frame-loc', `, ${f.source?.path ? basename(f.source.path) : f.source?.name || '?'}:${f.line}`));
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
      return { name: expression, error: remoteError(err), variablesReference: 0, s };
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
        row.append(el('span', 'dbg-arrow'), data('dbg-name', r.name), el('span', 'dbg-eq muted', sess ? `  ${tr('(not suspended)')}` : ''));
        n.appendChild(row);
        return n;
      })() : varNode(r, 'W', 0);
      node.classList.add('dbg-watch');
      node.classList.toggle('selected', i === selectedWatch);
      node.firstChild.addEventListener('mousedown', () => { selectedWatch = i; watchesList.querySelectorAll('.dbg-watch').forEach((w, j) => w.classList.toggle('selected', j === i)); });
      const del = el('button', 'dbg-watch-del', '×');
      del.title = tr('Remove Watch');
      del.onclick = (e) => { e.stopPropagation(); removeWatch(i); };
      node.firstChild.appendChild(del);
      return node;
    }));
    if (!watches.length) watchesList.appendChild(el('div', 'dbg-empty', tr('No watches. Add one with +')));
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
    input.placeholder = tr('Expression (Enter to evaluate)');
    const sel = ide.editor.getSelection();
    const model = ide.editor.getModel();
    if (model && sel && !sel.isEmpty()) input.value = model.getValueInRange(sel);
    else if (model && sel) input.value = model.getWordAtPosition(sel.getPosition())?.word || '';
    const result = el('div', 'dbg-eval-result');
    result.id = 'dbgEvalResult';
    body.append(input, result);
    const dlg = ide.ui.dialog({
      title: tr('Evaluate'),
      body,
      width: 620,
      buttons: [
        { label: tr('Add Watch'), run: () => { addWatch(input.value); return false; } },
        { label: tr('Close') },
        { label: tr('Evaluate'), primary: true, run: async () => {
          const expr = input.value.trim();
          if (!expr) return false;
          const r = await evaluate(expr, 'repl');
          result.replaceChildren(varNode({ ...r, name: 'result', label: tr('result') }, `E/${expr}`, 0));
          input.select();
          return false;
        } },
      ],
    });
    dlg.el.classList.add('dbg-dialog');
    setTimeout(() => { input.focus(); input.select(); });
  }

  // ---------- breakpoints dialog (Ctrl+Shift+F8) ----------
  // What a breakpoint does besides suspending, for the Breakpoints list: condition and log message are program text.
  function bpSummary(bp) {
    const box = el('span', 'dbg-bps-summary');
    if (bp.condition) box.append(data('muted', `  [${bp.condition}]`));
    if (bp.hitCondition) box.append(el('span', 'muted', `  ${tr('hit {count}', { count: bp.hitCondition })}`));
    if (bp.logMessage) box.append(el('span', 'muted', `  ${tr('log:')} `), data('muted dbg-bps-log', `"${bp.logMessage}"`));
    return box;
  }

  // select: {path, line} of the breakpoint to show first.
  function breakpointsDialog(select = null) {
    closeBpPopup?.();
    const body = el('div', 'dbg-bps');
    const list = el('div', 'dbg-bps-list');
    list.id = 'dbgBpList';
    const detail = el('div', 'dbg-bps-detail');
    body.append(list, detail);
    let current = select ? allBps().find((e) => samePath(e.path, select.path) && e.bp.line === select.line) || null : null;
    let shown = null; // the breakpoint whose fields the detail pane holds, so edits there are not rebuilt under the caret
    let dlg;
    const render = () => {
      const entries = allBps().sort((a, b) => a.path.localeCompare(b.path) || a.bp.line - b.bp.line);
      if (current && !entries.some((e) => e.bp === current.bp)) current = null;
      current ||= entries[0] || null;
      list.replaceChildren(el('div', 'dbg-bps-group', tr('Python Line Breakpoints ({count})', { count: entries.length })), ...entries.map((e) => {
        const row = el('div', 'dbg-bps-row' + (e === current || e.bp === current?.bp ? ' selected' : ''));
        const cb = el('input');
        cb.type = 'checkbox';
        cb.checked = e.bp.enabled;
        cb.onclick = (ev) => { ev.stopPropagation(); setBp(e.path, e.bp.line, { enabled: cb.checked }); };
        row.append(cb, el('span', `dbg-bp-dot${bpClasses(e.bp)}`), data(null, `${basename(e.path)}:${e.bp.line}`), bpSummary(e.bp));
        row.onclick = () => { current = e; render(); };
        row.ondblclick = () => { dlg.close(); ide.openFile(e.path, { line: e.bp.line }); };
        return row;
      }));
      if (!entries.length) list.appendChild(el('div', 'dbg-empty', tr('No breakpoints')));
      if (fromDetail && shown === current?.bp) return;
      shown = current?.bp || null;
      detail.replaceChildren();
      if (!current) return;
      const { path, bp } = current;
      const title = el('div', 'dbg-bps-title', `${ide.util.rel(path)}:${bp.line}`);
      title.dataset.userText = '';
      detail.append(title);
      const fields = bpFields(bp, (props) => {
        fromDetail = true;
        try { setBp(path, bp.line, props); } finally { fromDetail = false; }
      }, { condition: 'dbgBpListCondition', hit: 'dbgBpListHit', log: 'dbgBpListLog' });
      const actions = el('div', 'dbg-bps-actions');
      const go = el('button', 'secondary', tr('Go to Source'));
      go.onclick = () => { dlg.close(); ide.openFile(path, { line: bp.line }); };
      const rm = el('button', 'secondary', tr('Remove'));
      rm.id = 'dbgBpRemove';
      rm.onclick = () => removeBp(path, bp.line);
      actions.append(go, rm);
      detail.append(fields.el, actions);
    };
    let fromDetail = false;
    bpListener = render;
    render();
    dlg = ide.ui.dialog({
      title: tr('Breakpoints'),
      body,
      width: 720,
      buttons: [{ label: tr('Done'), primary: true, run: () => { document.activeElement?.blur?.(); } }],
      onClose: () => { if (bpListener === render) bpListener = null; },
    });
    dlg.el.classList.add('dbg-dialog');
  }

  // ---------- tool window ----------
  let con, tw, subTabs, subPanes, lastFile = null, lastCfg = {};
  const btns = {};

  function showSub(which) {
    for (const [k, b] of Object.entries(subTabs)) b.classList.toggle('active', k === which);
    for (const [k, p] of Object.entries(subPanes)) p.classList.toggle('hidden', k !== which);
  }

  const withKeys = (title, keys) => `${title} (${keys})`;

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
    id: 'Debug', title: tr('Debug'), icon: '🐞', side: 'bottom', keys: 'Alt+5', order: 15,
    mount(container) {
      container.classList.add('dbg-root');
      const bar = el('div', 'dbg-bar');
      subTabs = { debugger: el('button', 'dbg-subtab', tr('Threads & Variables')), console: el('button', 'dbg-subtab', tr('Console')) };
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
      mk('Rerun', '↻', tr('Rerun'), () => debugFile(sess?.file || lastFile, lastCfg), 'green');
      mk('Resume', '▶', withKeys(tr('Resume Program'), 'F9'), () => step('continue'), 'green');
      mk('Pause', '⏸', tr('Pause Program'), pause);
      mk('Stop', '■', withKeys(tr('Stop'), 'Ctrl+F2'), stopDebug, 'red');
      bar.appendChild(el('span', 'dbg-sep'));
      mk('StepOver', '↷', withKeys(tr('Step Over'), 'F8'), () => step('next'), 'blue');
      mk('StepInto', '↘', withKeys(tr('Step Into'), 'F7'), () => step('stepIn'), 'blue');
      mk('StepOut', '↖', withKeys(tr('Step Out'), 'Shift+F8'), () => step('stepOut'), 'blue');
      mk('RunToCursor', '⇥', withKeys(tr('Run to Cursor'), 'Alt+F9'), runToCursor, 'blue');
      bar.appendChild(el('span', 'dbg-sep'));
      mk('Evaluate', '⌨', withKeys(tr('Evaluate Expression'), 'Alt+F8'), evaluateDialog);
      mk('Breakpoints', '●', withKeys(tr('View Breakpoints'), 'Ctrl+Shift+F8'), () => breakpointsDialog(), 'red');

      const vars = el('div', 'dbg-panes');
      const frames = pane(tr('Frames'));
      threadLabel = el('span', 'dbg-thread muted');
      frames.head.insertBefore(threadLabel, frames.head.children[1]);
      framesList = frames.list;
      framesList.id = 'dbgFrames';
      const variables = pane(tr('Variables'));
      varsList = variables.list;
      varsList.id = 'dbgVars';
      const watchPane = pane(tr('Watches'), [
        { id: 'dbgWatchAdd', icon: '+', title: tr('New Watch'), run: () => { watchInput.classList.remove('hidden'); watchInput.focus(); } },
        { id: 'dbgWatchRemove', icon: '−', title: withKeys(tr('Remove Watch'), 'Delete'), run: () => removeWatch() },
      ]);
      watchesList = watchPane.list;
      watchesList.id = 'dbgWatches';
      watchesList.tabIndex = 0;
      watchesList.onkeydown = (e) => { if (e.key === 'Delete') { e.preventDefault(); removeWatch(); } };
      const watchInput = el('input', 'dbg-watch-input hidden');
      watchInput.id = 'dbgWatchInput';
      watchInput.placeholder = tr('Expression to watch (Enter)');
      watchInput.onkeydown = (e) => {
        if (e.key === 'Enter') { addWatch(watchInput.value); watchInput.value = ''; watchInput.classList.add('hidden'); }
        if (e.key === 'Escape') { e.stopPropagation(); watchInput.value = ''; watchInput.classList.add('hidden'); }
      };
      watchPane.p.insertBefore(watchInput, watchesList);
      vars.append(frames.p, variables.p, watchPane.p);

      const consoleHost = el('div', 'dbg-console hidden');
      con = ide.ui.console(consoleHost, {
        input: true,
        placeholder: tr('stdin: type program input and press Enter'),
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
      evalIn.placeholder = tr('Evaluate expression in the selected frame (Enter)');
      evalIn.onkeydown = async (e) => {
        if (e.key !== 'Enter') return;
        const expr = evalIn.value.trim();
        if (!expr) return;
        evalIn.value = '';
        con.append(`>>> ${expr}\n`, 'cmd');
        if (!suspended()) return con.append(`${tr('Evaluation is available only while the program is suspended')}\n`, 'err');
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
  debugBtn.title = withKeys(tr('Debug'), 'Shift+F9');
  debugBtn.appendChild(ide.icon('runDebug', '🐞'));
  ide.registerToolbarItem({ order: 80, el: debugBtn });

  function debugCurrent() {
    const tab = ide.activeTab();
    if (tab?.kind === 'file' && tab.path.endsWith('.py')) return debugFile(tab.path);
    if (lastFile) return debugFile(lastFile, lastCfg);
    tw.show();
    showSub('console');
    con.append(`${tr('Open a .py file to debug it.')}\n`, 'sys');
  }
  debugBtn.onclick = debugCurrent;
  updateControls();

  const hasFile = () => !!activeFile();
  // Like PyCharm: in an editor on a breakpoint's line, Ctrl+Shift+F8 edits that breakpoint inline; elsewhere it lists them.
  function viewOrEditBreakpoint() {
    const ed = ide.editor;
    const path = ed?.hasTextFocus() && pathOf(ed);
    const bp = path && findBp(path, ed.getPosition().lineNumber);
    if (bp) editBpPopup(path, bp, ed);
    else breakpointsDialog();
  }
  [
    { id: 'Debug', title: tr('Debug'), keys: 'Shift+F9', run: debugCurrent },
    { id: 'ToggleLineBreakpoint', title: tr('Toggle Line Breakpoint'), keys: 'Ctrl+F8', when: hasFile,
      run: () => toggleBp(activeFile().path, ide.editor.getPosition().lineNumber) },
    { id: 'ViewBreakpoints', title: tr('View Breakpoints…'), keys: 'Ctrl+Shift+F8', run: viewOrEditBreakpoint },
    { id: 'StepOver', title: tr('Step Over'), keys: 'F8', when: suspended, run: () => step('next') },
    { id: 'StepInto', title: tr('Step Into'), keys: 'F7', when: suspended, run: () => step('stepIn') },
    { id: 'StepOut', title: tr('Step Out'), keys: 'Shift+F8', when: suspended, run: () => step('stepOut') },
    { id: 'Resume', title: tr('Resume Program'), keys: 'F9', when: suspended, run: () => step('continue') },
    { id: 'Pause', title: tr('Pause Program'), when: () => sess?.state === 'running', run: pause },
    { id: 'RunToCursor', title: tr('Run to Cursor'), keys: 'Alt+F9', when: suspended, run: runToCursor },
    { id: 'EvaluateExpression', title: tr('Evaluate Expression…'), keys: 'Alt+F8', when: suspended, run: evaluateDialog },
  ].forEach(ide.registerAction);
  // Registered after every feature has loaded so it takes precedence over run's Ctrl+F2, but only while debugging.
  ide.on('ready', () => ide.registerAction({ id: 'StopDebug', title: tr('Stop Debugging'), keys: 'Ctrl+F2', when: () => !!sess, run: stopDebug }));
  ide.registerTreeAction({ title: tr("Debug '…'"), when: (e) => !e.dir && e.name.endsWith('.py'), run: (e) => debugFile(e.path) });

  // evaluate(expression, context) runs in the selected frame and resolves {value, type} or {error}.
  // 'debugContextChanged' fires when the selected frame changes or the program resumes or ends.
  ide.debugger = {
    debugFile,
    isActive: () => !!sess,
    isSuspended: suspended,
    evaluate: (expression, context = 'repl') => (suspended() ? evaluate(expression, context) : Promise.resolve({ error: tr('Not suspended') })),
    addVariableDecorator: (fn) => varDecorators.push(fn),
  };
  window.__debugger = { state: () => sess && { id: sess.id, state: sess.state, frameIdx: sess.frameIdx, frames: sess.frames.map((f) => ({ name: f.name, line: f.line, path: f.source?.path })) }, breakpoints: () => allBps().map(({ path, bp }) => ({ path, ...bp })) };
})();
