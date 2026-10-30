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

  // Code a plugin generates and debugs for the user (a visual script's Python) stands for what the user edits: the
  // plugin owns its breakpoints and frame labels, and shows a stop in it on 'debugContextChanged' instead of the file
  // being opened. source: {owns(path), breakpoints(path) -> DAP SourceBreakpoints, label(path, line) -> text,
  // variableLabel?(path, name) -> text | null}: variableLabel names a variable of a frame in the file in Variables (a
  // node's title for a generated local); the name itself stays in the row's tooltip and in evaluation.
  const generatedSources = [];
  const generatedFor = (path) => (path ? generatedSources.find((g) => g.owns(path)) : null);

  function bpPayload(path) {
    const lines = fileBps(path).filter((b) => b.enabled).map((b) => ({ line: b.line, ...(b.condition ? { condition: b.condition } : {}),
      ...(b.hitCondition ? { hitCondition: b.hitCondition } : {}), ...(b.logMessage ? { logMessage: b.logMessage } : {}) }));
    for (const b of generatedFor(path)?.breakpoints(path) || []) if (!lines.some((l) => l.line === b.line)) lines.push(b);
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

  // ---------- Python exception breakpoints ----------
  // PyCharm's "Python Exception Breakpoints": "Any exception" (type null) and the classes the user added, by builtin
  // name (ValueError) or module path (myapp.errors.AppError). onRaise suspends where the exception is raised, onTerminate
  // when it ends the program; condition is evaluated in the frame that stops, where __exception__ is (type, value,
  // traceback). Saved per project like line breakpoints.
  let excBps = [];
  const excSettingsKey = () => `debugger.exceptionBreakpoints:${ide.root}`;
  const EXC_CLASS = /^[\p{L}_][\p{L}\p{M}\p{N}_]*(\.[\p{L}_][\p{L}\p{M}\p{N}_]*)*$/u;
  const excBp = (type, b = {}) => ({
    type,
    enabled: typeof b.enabled === 'boolean' ? b.enabled : true,
    onRaise: typeof b.onRaise === 'boolean' ? b.onRaise : type !== null,
    onTerminate: typeof b.onTerminate === 'boolean' ? b.onTerminate : type === null,
    condition: typeof b.condition === 'string' ? b.condition : '',
  });
  const excName = (bp) => bp.type ?? tr('Any exception');

  function loadExcBps() {
    const saved = ide.settings.get(excSettingsKey(), []);
    const list = Array.isArray(saved) ? saved.filter((b) => b && (b.type === null || EXC_CLASS.test(b.type))) : [];
    const types = [...new Set(list.map((b) => b.type).filter((t) => t !== null))];
    excBps = [excBp(null, list.find((b) => b.type === null)), ...types.map((t) => excBp(t, list.find((b) => b.type === t)))];
  }
  function afterExcChange() {
    if (ide.root) ide.settings.set(excSettingsKey(), excBps);
    sendExcBps();
    bpListChanged();
  }
  const setExcBp = (bp, props) => { Object.assign(bp, props); afterExcChange(); };
  function addExcBp(type) {
    let bp = excBps.find((b) => b.type === type);
    if (!bp) excBps.push((bp = excBp(type)));
    afterExcChange();
    return bp;
  }
  function removeExcBp(bp) {
    if (bp.type === null) return;
    excBps = excBps.filter((b) => b !== bp);
    afterExcChange();
  }

  // pydevd resolves each class by evaluating its name once, before the program runs, and a name it cannot use as an
  // exception class (json.NoSuch, os.sep, True) raises in pydevd's request reader, which ends the debug session. So each
  // name goes as an expression that gives the class or None (no breakpoint): a builtin by name, a dotted name through
  // importlib. A nested class (mod.Outer.Inner) and one defined in the script being debugged cannot be named.
  const PY_EXCEPTIONS = { names: ['Python Exceptions'] };
  // 'mod.sub.Cls' -> ['mod.sub', 'Cls']; a builtin's module is ''.
  const splitClass = (type) => { const i = type.lastIndexOf('.'); return [i < 0 ? '' : type.slice(0, i), type.slice(i + 1)]; };
  function pydevdClass(type) {
    const [mod, name] = splitClass(type);
    const found = mod ? `getattr(__import__('importlib').import_module('${mod}'), '${name}', None)` : `getattr(__import__('builtins'), '${name}', None)`;
    return `(lambda b, c: c if b.isinstance(c, b.type) and b.issubclass(c, b.BaseException) else None)(__import__('builtins'), ${found})`;
  }
  function excPayload() {
    const exceptionOptions = [];
    for (const bp of excBps.filter((b) => b.enabled)) {
      const path = bp.type === null ? [PY_EXCEPTIONS] : [PY_EXCEPTIONS, { names: [pydevdClass(bp.type)] }];
      if (bp.onRaise) exceptionOptions.push({ path, breakMode: 'always' });
      if (bp.onTerminate) exceptionOptions.push({ path, breakMode: 'unhandled' });
    }
    return { filters: [], exceptionOptions };
  }
  function sendExcBps() {
    if (!sess) return;
    if (!sess.id) { sess.pendingExc = true; return; }
    req('setExceptionBreakpoints', excPayload()).catch(() => {});
  }

  // The class a stopped exception is matched to in the stopped frame, as pydevd matches it: the most derived of the
  // breakpoints' classes in the exception's MRO. Resolves to that breakpoint's index or -1. Builtins come from the
  // builtins module (b), since the frame may have its own max or len.
  const pyClass = (type) => {
    if (type === null) return 'b.BaseException';
    const [mod, name] = splitClass(type);
    return mod ? `b.getattr(b.__import__('sys').modules.get('${mod}'), '${name}', None)` : `b.getattr(b, '${name}', None)`;
  };
  const matchExpr = (list) => `(lambda b: (lambda t, cs: b.max([(b.len(c.__mro__), i) for i, c in b.enumerate(cs) if c in t.__mro__] or [(0, -1)])[1])`
    + `(__exception__[0], [${list.map((x) => pyClass(x.type)).join(', ')}]))(__import__('builtins'))`;
  const stackKey = (frames) => frames.map((f) => `${f.name}\n${f.source?.path || ''}\n${f.line}`);
  const stepping = (p) => !!p.resumedBy && p.resumedBy !== 'continue';
  // How to go on from an exception stop that is passed over: a step over that ended up deeper (the exception was
  // raised in a call it steps over) first steps out back towards the frame it started in.
  const resumeAfterPassOver = (p, frames) => (!stepping(p) ? 'continue'
    : p.resumedBy === 'next' && frames.length > p.resumeDepth ? 'stepOut' : p.resumedBy);

  // Whether a stop on an exception is shown. pydevd stops on a raised exception again in each caller it propagates
  // through, where PyCharm's "On raise" suspends once: a stop for the same exception whose stack is the last one's
  // minus its top frame is passed over, unless a step brought it there (a step out of the raise ends in the caller).
  // Conditions are evaluated here, because pydevd takes none through DAP.
  // p: the process that stopped (sess.procs).
  async function wantExceptionStop(p, threadId, frames) {
    const req = (command, args) => reqTo(p.id, command, args);
    const info = await req('exceptionInfo', { threadId }).catch(() => null);
    p.exceptionMode = info?.breakMode || null;
    const keys = stackKey(frames);
    if (info?.breakMode === 'always') {
      const last = p.raised;
      p.raised = { id: info.exceptionId, description: info.description, keys };
      if (!stepping(p) && last && last.id === info.exceptionId && last.description === info.description
        && last.keys.length === keys.length + 1 && last.keys.slice(1).every((k, i) => k === keys[i])) return false;
    }
    const field = { always: 'onRaise', unhandled: 'onTerminate' }[info?.breakMode];
    const candidates = field ? excBps.filter((b) => b.enabled && b[field]) : [];
    if (!candidates.some((b) => b.condition.trim()) || !frames[0]) return true;
    const frameId = frames[0].id;
    const match = await req('evaluate', { expression: matchExpr(candidates), frameId, context: 'watch' }).catch(() => null);
    const bp = candidates[Number(match?.result)];
    if (!bp?.condition.trim()) return true;
    try {
      // On lines of their own, so a trailing # comment in the condition does not swallow the closing parentheses.
      const expression = `__import__('builtins').bool((\n${bp.condition.trim()}\n))`;
      return (await req('evaluate', { expression, frameId, context: 'watch' })).result === 'True';
    } catch (err) {
      con.append(`${tr('Error evaluating the condition of the {type} exception breakpoint: {error}', { type: excName(bp), error: remoteError(err) })}\n`, 'err');
      return true;
    }
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

  const checkRow = (label, checked) => {
    const row = el('label', 'dbg-check');
    const cb = el('input');
    cb.type = 'checkbox';
    cb.checked = checked;
    row.append(cb, el('span', null, label));
    return { row, cb };
  };
  const textInput = (id, value, placeholder) => {
    const i = el('input', 'input');
    if (id) i.id = id;
    i.value = value;
    i.placeholder = placeholder;
    i.spellcheck = false;
    return i;
  };
  const fieldRow = (label, ...nodes) => { const r = el('div', 'dbg-bp-field'); r.append(el('span', 'dbg-bp-label', label), ...nodes); return r; };

  // The fields PyCharm's breakpoint popup and the Breakpoints dialog share. onChange gets the edited props; path is
  // the breakpoint's file (a .java file's condition is a Java expression).
  function bpFields(bp, onChange, ids = {}, path = '') {
    const box = el('div', 'dbg-bp-fields');
    const en = checkRow(tr('Enabled'), bp.enabled);
    const cond = textInput(ids.condition, bp.condition, /\.java$/i.test(path) ? tr('Java expression, e.g. i == 3') : tr('Python expression, e.g. i == 3'));
    const hit = textInput(ids.hit, bp.hitCondition, tr('e.g. 3, >= 3 or % 3'));
    hit.classList.add('dbg-bp-hit');
    const log = checkRow(tr('Log message instead of suspending'), !!bp.logMessage);
    const msg = textInput(ids.log, bp.logMessage, tr('e.g. i = {i}, total = {total}'));
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
    box.append(en.row, fieldRow(tr('Condition:'), cond), fieldRow(tr('Hit count:'), hit), log.row, msg,
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
    const fields = bpFields(bp, null, { condition: 'dbgBpCondition', hit: 'dbgBpHit', log: 'dbgBpLog' }, path);
    const foot = el('div', 'dbg-bp-popup-foot');
    const more = el('button', 'link', ide.keymap.withKeys(tr('More'), 'ViewBreakpoints'));
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
      if (e.isComposing) return;
      // View Breakpoints' own shortcut (as the keymap has it) opens the full dialog, like the More link.
      const viewAll = !!ide.actions.find((a) => a.id === 'ViewBreakpoints')?.keys.includes(ide.keymap.comboOf(e));
      if (e.key === 'Escape' || e.key === 'Enter' || viewAll) {
        e.preventDefault();
        e.stopPropagation();
        close();
        if (viewAll) breakpointsDialog({ path, line });
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
  // sess.procs: the session's processes, the program (or attached process, under sess.id) and each Python process it
  // started (subprocess, multiprocessing; debugpy attaches to them as PyCharm's "Attach to subprocess automatically"
  // does): id -> {id, pid, name, child, stop (the 'stopped' body while it is suspended), resumedBy, resumeDepth,
  // raised, exceptionMode}. sess.cur is the one Frames, Variables, Watches and the stepping actions are for.
  let sess = null; // {id, file, state: 'starting'|'running'|'suspended', threadId, frames, frameIdx, tempBp, procs, cur}
  let earlyEvents = [];
  let startKeys = 0;
  const reqTo = (id, command, args) => ide.api.invoke('debug:request', id, command, args);
  const req = (command, args) => reqTo(sess.cur, command, args);
  const addProc = (s, id, props = {}) => s.procs.set(id, { id, pid: null, name: null, child: false, stop: null, ...props });
  const SUBPROCESS_SETTING = 'debugger.attachSubprocess';
  const suspended = () => sess?.state === 'suspended';

  // Errors from main/features/debug.js arrive as English text; its own messages are translated here, while
  // debugpy's (exception text, OS errors) pass through unchanged.
  const MAIN_ERRORS = [
    [/^Could not connect to debugpy on port (\d+): ([\s\S]*)$/, (m) => tr('Could not connect to debugpy on port {port}: {error}', { port: m[1], error: m[2] })],
    [/^Debug session closed$/, () => tr('Debug session closed')],
    [/^debugpy did not start the debug session within (\d+) seconds$/, (m) => tr('debugpy did not start the debug session within {seconds} seconds', { seconds: m[1] })],
    [/^No debug session$/, () => tr('No debug session')],
    [/^(\w+) failed$/, (m) => tr('{command} failed', { command: m[1] })],
    // Attach to Process (main/features/debug-attach.js and debug.js)
    [/^Process (\d+) is not running$/, (m) => tr('Process {pid} is not running (it may have exited)', { pid: m[1] })],
    [/^Access denied: cannot attach to process (\d+)$/, (m) => tr('Access denied: process {pid} runs as administrator or as another user. Run PyIDE as administrator to attach to it.', { pid: m[1] })],
    [/^Process (\d+) exited before the debugger connected$/, (m) => tr('Process {pid} exited before the debugger connected', { pid: m[1] })],
    [/^Process (\d+) did not start the debugger within (\d+) seconds; it may be blocked in native code or waiting for input$/,
      (m) => tr('Process {pid} did not start the debugger within {seconds} seconds; it may be blocked in native code or waiting for input', { pid: m[1], seconds: m[2] })],
    [/^Python (\S+) is not supported by the bundled debugpy \(Python (\S+) or later is required\)$/,
      (m) => tr('Python {version} is not supported by the bundled debugpy (Python {min} or later is required)', { version: m[1], min: m[2] })],
    [/^Injecting the debugger into process (\d+) timed out after (\d+) seconds$/, (m) => tr('Injecting the debugger into process {pid} timed out after {seconds} seconds', { pid: m[1], seconds: m[2] })],
    [/^Could not inject the debugger into process (\d+): ([\s\S]*)$/, (m) => tr('Could not inject the debugger into process {pid}: {error}', { pid: m[1], error: m[2] })],
    [/^Cannot run the interpreter of process (\d+): ([\s\S]*)$/, (m) => tr('Cannot run the interpreter of process {pid}: {path}', { pid: m[1], path: m[2] })],
    [/^Listing processes timed out after (\d+) seconds$/, (m) => tr('Listing processes timed out after {seconds} seconds', { seconds: m[1] })],
    [/^Could not list processes: ([\s\S]*)$/, (m) => tr('Could not list processes: {error}', { error: m[1] })],
    [/^No Python interpreter found\.$/, () => tr('No Python interpreter found.')],
    [/^No process selected$/, () => tr('No process selected')],
    [/^Debugging stopped$/, () => tr('Debugging stopped')],
    [/^The program exited before the debugger could connect$/, () => tr('The program exited before the debugger could connect')],
    // Java (main/features/debug-jvm.js and debug-jvm-eval.js)
    [/^Unable to open debugger port \(([^)]+)\): ([\s\S]*)$/, (m) => tr('Unable to open debugger port ({address}): {error}', { address: m[1], error: m[2] })],
    [/^The JVM did not answer the JDWP handshake$/, () => tr('The JVM did not answer the JDWP handshake')],
    [/^Not a JDWP agent$/, () => tr('The port is not a JDWP debug port')],
    [/^The JVM closed the connection$/, () => tr('The JVM closed the connection')],
    [/^Not suspended$/, () => tr('Not suspended')],
    [/^The frame is no longer available$/, () => tr('The frame is no longer available')],
    [/^Evaluation is available only while the program is suspended$/, () => tr('Evaluation is available only while the program is suspended')],
    [/^Methods can be called only in a thread suspended by a breakpoint or a step$/, () => tr('Methods can be called only in a thread suspended by a breakpoint or a step')],
    [/^Cannot find symbol (\S+)$/, (m) => tr("Cannot find symbol '{name}'", { name: m[1] })],
    [/^Cannot find method (\S+?)\((…?)\) in (\S+)$/, (m) => tr("Cannot find method '{name}' in {type}", { name: m[1], type: m[3] })],
    [/^Method threw '(\S+)' exception\.$/, (m) => tr("Method threw '{type}' exception.", { type: m[1] })],
    [/^Unexpected end of expression$/, () => tr('Unexpected end of expression')],
    [/^Unexpected '(.+)'$/, (m) => tr("Unexpected '{text}'", { text: m[1] })],
    [/^'(\S+)' is not supported$/, (m) => tr("'{text}' is not supported in evaluation", { text: m[1] })],
  ];
  // The debugger's own messages first: errorText words a bare network code as the internet being unreachable, which
  // a debugpy on this machine that did not answer is not.
  function remoteError(err) {
    const msg = String(err?.message || err).replace(/^Error invoking remote method '[^']+': (Error: )?/, '');
    for (const [re, fn] of MAIN_ERRORS) { const m = re.exec(msg); if (m) return fn(m); }
    return ide.util.errorText(err);
  }

  ide.api.on('debug:event', (m) => {
    if (m.id === null && m.event === 'process') return followProcess(startups.get(m.startKey), m.body.id);
    if (sess && !sess.id) { earlyEvents.push(m); return; }
    if (sess && (m.root ?? m.id) === sess.id) handleEvent(m);
  });

  // m: {id, root?, event, body}; root is the session's id for an event of a process the program started.
  function handleEvent({ id, root, event, body }) {
    if (event === 'subprocess') {
      addProc(sess, id, { pid: body.pid, child: true });
      con.append(`${tr('Attached to subprocess {pid}', { pid: body.pid })}\n`, 'sys');
      return renderFrames();
    }
    const p = sess.procs.get(id);
    if (!p) return;
    if (event === 'process') {
      p.pid = body.systemProcessId ?? p.pid;
      p.name = body.name || null;
      renderFrames();
    } else if (event === 'stopped') onStopped(body, id);
    else if (event === 'continued') onContinued(id);
    else if (event === 'output') {
      if (body.category === 'telemetry') return;
      if (body.condition != null) {
        return con.append(`${tr("Breakpoint condition '{condition}' could not be evaluated: {error}", { condition: body.condition, error: remoteError(body.error) })}\n`, 'err');
      }
      con.append(body.output, body.category === 'stderr' ? 'err' : body.category === 'stdout' ? null : 'sys');
    } else if (root != null) {
      if (event === 'terminated' || event === 'exited' || event === 'closed') dropProc(id);
    } else if (sess.jvm && event === 'closed') {
      con.append(`${tr("Disconnected from the target VM, address: '{address}', transport: 'socket'", { address: sess.address })}\n`, 'sys');
      p.stop = null;
      if (sess.attach) endSession(sess, null);
      else if (sess.cur === id) setRunning();
    } else if (sess.attach && event === 'exited') {
      sess.exitCode = body.exitCode;
    } else if (sess.attach && event === 'closed') {
      // An attach session ends when its connection does: after Detach, or when the target exits.
      sess.exited = !!body.exited;
      endSession(sess, sess.exitCode);
    } else if (event === 'terminated' || event === 'exited' || event === 'closed') {
      p.stop = null;
      if (sess.cur === id) setRunning();
    }
  }

  // A process the program started has ended: the view goes back to a stop another one holds, or to the program.
  function dropProc(id) {
    if (!sess.procs.delete(id)) return;
    if (sess.cur !== id) return renderFrames();
    sess.cur = sess.id;
    if (!showNextStop()) showProc(sess.id);
  }

  // Shows the stop another process holds, if there is one.
  function showNextStop() {
    const next = [...sess.procs.values()].find((p) => p.stop && p.id !== sess.cur);
    if (next) showProc(next.id);
    return !!next;
  }

  // The process list's choice: its frames and variables when it is suspended, "Running" otherwise.
  function showProc(id) {
    const p = sess?.procs.get(id);
    if (!p) return;
    sess.cur = id;
    setRunning();
    if (p.stop) onStopped(p.stop, id, { again: true });
  }

  function onContinued(id) {
    const p = sess.procs.get(id);
    p.stop = null;
    if (sess.cur !== id) return renderFrames();
    // A Resume shows where another process is suspended; a step stays with this one until it stops again.
    if (!stepping(p) && showNextStop()) return;
    setRunning();
  }

  // The debuggee's output and exit from the moment main starts it, so a program that ends while debugpy is still
  // starting shows its own output and exit code. A startup already stopped or replaced (s is not sess) shows nothing.
  const startups = new Map(); // startKey -> the session of a debug:start in progress
  function followProcess(s, id) {
    if (s) s.procId = id;
    ide.proc.attach(id, {
      data: (text, stream) => s && sess === s && con.append(text, stream === 'err' ? 'err' : null),
      exit: (code) => s && endSession(s, code),
    });
  }

  // cfg (from a run configuration): {interp?, cwd?, params?, env?, envFiles?, rerun?, tabs?} (envFiles: absolute .env paths;
  // default the root's .env; tabs: the session's plugin sub-tabs, see setSessionTabs)
  // Resolves once the session runs, failed to start or already ended, to {ended}: a promise of {replaced} that settles
  // when this session ends (replaced: another debug session took its place). Undefined when no session was started.
  async function debugFile(file, cfg = {}) {
    if (!file) return;
    const interp = cfg.interp || ide.currentInterp();
    tw.show();
    showSub('console');
    if (!interp) { con.append(`${tr('No Python interpreter found.')}\n`, 'err'); return; }
    if (sess) await replaceSession();
    setSessionTabs(cfg.tabs);
    if (ide.settings.get('autosave.beforeRun', true)) await ide.saveAll();
    lastFile = file;
    lastCfg = cfg;
    // cfg.rerun: how a run configuration debugs again (a visual script is compiled again first).
    lastRun = cfg.rerun || (() => debugFile(file, cfg));
    con.clear();
    con.append(`${[interp.cmd, ...interp.args].join(' ')} -m debugpy ${[file, ...(cfg.params || [])].join(' ')}\n`, 'sys');
    sess = { id: null, startKey: ++startKeys, file, state: 'starting', frames: [], frameIdx: 0, pendingBps: new Set(), typed: [], procs: new Map(), cur: null };
    earlyEvents = [];
    const mine = sess;
    const handle = { ended: new Promise((resolve) => { mine.end = resolve; }) };
    const focusInput = takeInput(mine);
    updateControls();
    const files = [...bps.values()].map((f) => f.path).concat(generatedFor(file) && !bps.has(key(file)) ? [file] : [])
      .map(bpPayload).filter((p) => p.lines.length);
    let id;
    startups.set(mine.startKey, mine);
    try {
      const opts = { params: cfg.params || [], env: cfg.env || {}, envFiles: cfg.envFiles, roots: ide.root ? [ide.root] : [],
        startKey: mine.startKey, exceptions: excPayload(), subProcess: ide.settings.get(SUBPROCESS_SETTING, true) !== false };
      const write = (text) => sess === mine && con.append(text, 'err');
      const cwd = ide.run?.workingDir ? await ide.run.workingDir(cfg.cwd || dirname(file), write) : cfg.cwd || dirname(file);
      if (sess !== mine) return handle;
      ({ id } = await ide.api.invoke('debug:start', interp, file, cwd, files, opts));
    } catch (err) {
      mine.unwatch();
      // A startup the user stopped (or replaced) ends quietly: the console already says the process finished, as it
      // does for a program that ended before debugpy listened.
      if (sess === mine) {
        con.append(`${remoteError(err)}\n`, 'err');
        sess = null;
        con.input.disabled = true;
        updateControls();
      }
      mine.end({ replaced: !!mine.replaced });
      return handle;
    } finally {
      startups.delete(mine.startKey);
    }
    if (mine.procId !== id) followProcess(mine, id);
    if (sess !== mine) {
      mine.unwatch();
      // Stopped or superseded while debugpy was starting: tear this debuggee down instead of leaving it running unseen.
      ide.api.invoke('debug:stop', id).catch(() => {});
      return handle;
    }
    sess.id = id;
    sess.cur = id;
    addProc(sess, id);
    if (sess.state === 'starting') sess.state = 'running';
    con.append(`${tr('Connected to pydev debugger (build debugpy)')}\n`, 'sys');
    sessionStarted(sess, focusInput);
    return handle;
  }

  // The program's input takes the keyboard now, so an answer to input() never lands in the file; lines typed before
  // the debugger has started the program wait in s.typed. Once it runs, the returned focusInput() gives the input the
  // keyboard again unless the user has moved it elsewhere meanwhile.
  function takeInput(s) {
    con.input.disabled = false;
    con.input.focus();
    let left = false;
    const watch = (e) => { if (!con.out.parentElement.contains(e.target)) left = true; };
    document.addEventListener('focusin', watch, true);
    s.unwatch = () => document.removeEventListener('focusin', watch, true);
    return () => { s.unwatch(); if (!left && sess === s && tw.isVisible() && con.input.offsetParent) con.input.focus(); };
  }

  // Once the session has its id: the input typed meanwhile, the breakpoints changed meanwhile and the queued events.
  function sessionStarted(s, focusInput) {
    updateControls();
    focusInput?.();
    for (const text of s.typed?.splice(0) || []) ide.proc.input(s.id, `${text}\n`);
    for (const p of s.pendingBps) sendBps(p);
    s.pendingBps.clear();
    if (s.pendingExc) sendExcBps();
    const queued = earlyEvents.filter((m) => (m.root ?? m.id) === s.id);
    earlyEvents = [];
    for (const m of queued) handleEvent(m);
  }

  // ---------- Java (main/features/debug-jvm.js, a JDWP client) ----------
  // spec: {launch({con, port, cancelled}) -> {procId, sourceRoots?, suspended?, timeoutMs?} | null, rerun?, tabs?}.
  // launch builds the program into the console and starts it with -agentlib:jdwp=transport=dt_socket,server=y,
  // suspend=y,address=127.0.0.1:<port> (null: it did not, and said why in con). procId is the process that runs it
  // (java, or a build tool that starts the JVM, which timeoutMs gives longer to listen), followed as a run is; null
  // attaches to a JVM that runs elsewhere, and Stop then detaches. Resolves like debugFile.
  async function debugJvm(spec) {
    tw.show();
    showSub('console');
    if (sess) await replaceSession();
    setSessionTabs(spec.tabs);
    if (ide.settings.get('autosave.beforeRun', true)) await ide.saveAll();
    lastFile = null;
    lastRun = spec.rerun || (() => debugJvm(spec));
    con.clear();
    sess = { id: null, startKey: ++startKeys, jvm: true, file: null, state: 'starting', frames: [], frameIdx: 0, pendingBps: new Set(), typed: [], procs: new Map(), cur: null };
    earlyEvents = [];
    const mine = sess;
    const handle = { ended: new Promise((resolve) => { mine.end = resolve; }) };
    const focusInput = takeInput(mine);
    updateControls();
    const files = [...bps.values()].filter((f) => /\.java$/i.test(f.path)).map((f) => bpPayload(f.path)).filter((p) => p.lines.length);
    const quit = (text) => {
      mine.unwatch();
      if (sess === mine) {
        if (text) con.append(`${text}\n`, 'err');
        sess = null;
        con.input.disabled = true;
        updateControls();
      }
      mine.end({ replaced: !!mine.replaced });
      return handle;
    };
    let id;
    startups.set(mine.startKey, mine);
    try {
      const port = await ide.api.invoke('debug:freePort');
      const target = await spec.launch({ con, port, cancelled: () => sess !== mine });
      if (!target) return quit();
      mine.address = `127.0.0.1:${port}`;
      if (target.procId == null) mine.attach = mine.address;
      else followProcess(mine, target.procId);
      if (sess !== mine) {
        if (target.procId != null) ide.proc.kill(target.procId);
        return handle;
      }
      ({ id } = await ide.api.invoke('debug:jvm', { port, procId: target.procId ?? null }, files, { startKey: mine.startKey,
        sourceRoots: target.sourceRoots || [], suspended: target.suspended !== false, timeoutMs: target.timeoutMs }));
    } catch (err) {
      return quit(remoteError(err));
    } finally {
      startups.delete(mine.startKey);
    }
    if (sess !== mine) {
      mine.unwatch();
      ide.api.invoke('debug:stop', id).catch(() => {});
      return handle;
    }
    sess.id = id;
    sess.cur = id;
    addProc(sess, id);
    if (sess.state === 'starting') sess.state = 'running';
    con.append(`${tr("Connected to the target VM, address: '{address}', transport: 'socket'", { address: mine.address })}\n`, 'sys');
    sessionStarted(sess, focusInput);
    return handle;
  }

  // A replaced session's process exits after the next session started: that still settles the replaced one's ended.
  function endSession(s, code) {
    s.end?.({ replaced: !!s.replaced });
    if (sess !== s) return;
    // A JVM attached to, or one still being built, has no exit of its own to report.
    const text = s.jvm && (s.attach || s.procId == null) ? null
      : !s.attach ? tr('Process finished with exit code {code}', { code: code ?? 1 })
        : code != null ? tr('Process {pid} finished with exit code {code}', { pid: s.attach, code })
          : s.exited ? tr('Process {pid} finished', { pid: s.attach }) : tr('Detached from process {pid}', { pid: s.attach });
    if (text) con.append(`\n${text}\n`, 'sys');
    s.unwatch?.();
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
    if (s.id) {
      await ide.api.invoke('debug:stop', s.id);
      // Detaching leaves the target running, so no process exit ends the session.
      if (s.attach) endSession(s, null);
    } else {
      // Still starting: end the session now and have main abort the startup, which kills the debuggee even when
      // debugpy never completes the handshake (debugFile also stops it should 'debug:start' still return an id).
      endSession(s, null);
      await ide.api.invoke('debug:stop', null, s.startKey).catch(() => {});
    }
  }

  // Starting another session in place of the running one.
  function replaceSession() {
    sess.replaced = true;
    return stopDebug();
  }

  // ---------- Attach to Process (Ctrl+Alt+F5) ----------
  // proc: an entry of 'debug:processes' ({pid, exe, interpreter, version, cmd, debugPort}). Breakpoints, stepping,
  // variables and the console work as in a launched session; Stop detaches and leaves the process running.
  async function attachToProcess(proc) {
    if (!proc?.pid) return;
    tw.show();
    showSub('console');
    if (sess) await replaceSession();
    setSessionTabs();
    lastRun = () => attachToProcess(proc);
    con.clear();
    con.append(`${tr('Attaching to process {pid}…', { pid: proc.pid })}${proc.cmd ? `  ${proc.cmd}` : ''}\n`, 'sys');
    sess = { id: null, startKey: ++startKeys, attach: proc.pid, file: null, state: 'starting', frames: [], frameIdx: 0, pendingBps: new Set(), procs: new Map(), cur: null };
    earlyEvents = [];
    const mine = sess;
    updateControls();
    const files = [...bps.values()].map((f) => bpPayload(f.path)).filter((p) => p.lines.length);
    let res;
    try {
      // Main looks the process up again by pid (its interpreter and debugpy port); created guards against a reused pid.
      res = await ide.api.invoke('debug:attach', { pid: proc.pid, created: proc.created || null }, files,
        { startKey: mine.startKey, exceptions: excPayload(), subProcess: ide.settings.get(SUBPROCESS_SETTING, true) !== false });
    } catch (err) {
      if (sess === mine) {
        con.append(`${tr('Cannot attach to process {pid}: {error}', { pid: proc.pid, error: remoteError(err) })}\n`, 'err');
        sess = null;
        updateControls();
      }
      return;
    }
    if (sess !== mine) {
      ide.api.invoke('debug:stop', res.id).catch(() => {});
      return;
    }
    sess.id = res.id;
    sess.cur = res.id;
    addProc(sess, res.id, { pid: proc.pid });
    if (sess.state === 'starting') sess.state = 'running';
    con.append(`${res.version ? tr('Attached to process {pid} (Python {version})', { pid: proc.pid, version: res.version })
      : tr('Attached to process {pid}', { pid: proc.pid })}\n`, 'sys');
    sessionStarted(sess);
  }

  // Processes whose command line (or working directory, where the OS tells it) is inside the project come first.
  const norm = (p) => String(p || '').replace(/\//g, '\\').toLowerCase();
  function inProject(proc) {
    if (!ide.root) return false;
    const root = norm(ide.root).replace(/\\+$/, '');
    return norm(proc.cmd).includes(`${root}\\`) || isUnder(norm(proc.cwd), root);
  }
  // What a row shows as the program: the command line without the interpreter.
  const programText = (proc) => (proc.cmd ? (proc.args.length ? proc.args.map((a) => (/\s/.test(a) ? `"${a}"` : a)).join(' ') : proc.name) : tr('(command line not available)'));

  function attachDialog() {
    const body = el('div', 'dbg-attach');
    const filter = el('input', 'input dbg-attach-filter');
    filter.id = 'dbgAttachFilter';
    filter.placeholder = tr('Filter by PID, script or command line');
    filter.spellcheck = false;
    const list = el('div', 'dbg-attach-list');
    list.id = 'dbgAttachList';
    const status = el('div', 'dbg-attach-status muted');
    status.id = 'dbgAttachStatus';
    body.append(filter, list, status);
    let procs = [];
    let shown = [];
    let selected = null; // pid
    let loading = null;
    let dlg;

    const select = (pid, scroll = true) => {
      selected = pid;
      for (const r of list.querySelectorAll('.dbg-attach-row')) {
        r.classList.toggle('selected', Number(r.dataset.pid) === pid);
        if (scroll && Number(r.dataset.pid) === pid) r.scrollIntoView({ block: 'nearest' });
      }
    };
    const render = () => {
      const words = filter.value.trim().toLowerCase().split(/\s+/).filter(Boolean);
      const hay = (p) => `${p.pid} ${p.name} ${p.cmd || ''} ${p.interpreter || ''}`.toLowerCase();
      shown = procs.filter((p) => words.every((w) => hay(p).includes(w)));
      const groups = [[tr('In this project'), shown.filter((p) => p.inProject)], [tr('Other Python processes'), shown.filter((p) => !p.inProject)]];
      const rows = [];
      for (const [title, items] of groups) {
        if (!items.length) continue;
        rows.push(el('div', 'dbg-attach-group', title));
        for (const p of items) {
          const row = el('div', 'dbg-attach-row');
          row.dataset.pid = p.pid;
          const line = el('div', 'dbg-attach-line');
          line.append(data('dbg-attach-pid', String(p.pid)), data('dbg-attach-cmd', programText(p), p.cmd || ''));
          if (p.debugPort) line.append(el('span', 'dbg-attach-tag', tr('debugpy listening')));
          const interp = el('div', 'dbg-attach-interp muted');
          interp.append(data(null, `${p.version ? `Python ${p.version}` : 'Python'}${p.interpreter ? ` · ${p.interpreter}` : ''}`));
          row.append(line, interp);
          row.title = p.cmd || '';
          row.onmousedown = () => select(p.pid, false);
          row.ondblclick = () => { select(p.pid, false); attachSelected(); };
          rows.push(row);
        }
      }
      list.replaceChildren(...rows);
      const ordered = [...groups[0][1], ...groups[1][1]];
      if (!ordered.some((p) => p.pid === selected)) selected = ordered[0]?.pid ?? null;
      select(selected);
      if (loading) status.textContent = tr('Looking for Python processes…');
      else if (!procs.length) status.textContent = tr('No Python processes found');
      else if (!shown.length) status.textContent = tr('Nothing matches the filter');
      else status.textContent = tr('{count} Python processes', { count: shown.length });
    };
    const load = async () => {
      const my = (loading = {});
      status.textContent = tr('Looking for Python processes…');
      status.classList.remove('err');
      try {
        const res = await ide.api.invoke('debug:processes');
        if (loading !== my) return;
        procs = res.map((p) => ({ ...p, inProject: inProject(p) }))
          .sort((a, b) => (b.inProject - a.inProject) || String(b.created || '').localeCompare(String(a.created || '')) || b.pid - a.pid);
        loading = null;
        render();
      } catch (err) {
        if (loading !== my) return;
        loading = null;
        procs = [];
        render();
        status.textContent = remoteError(err);
        status.classList.add('err');
      }
    };
    function attachSelected() {
      const p = procs.find((x) => x.pid === selected);
      if (!p) return false;
      dlg.close();
      attachToProcess(p);
      return true;
    }
    filter.oninput = render;
    filter.onkeydown = (e) => {
      if (e.key !== 'ArrowDown' && e.key !== 'ArrowUp' && e.key !== 'PageDown' && e.key !== 'PageUp') return;
      e.preventDefault();
      const order = [...list.querySelectorAll('.dbg-attach-row')].map((r) => Number(r.dataset.pid));
      if (!order.length) return;
      const i = order.indexOf(selected);
      const step = e.key === 'ArrowDown' ? 1 : e.key === 'ArrowUp' ? -1 : e.key === 'PageDown' ? 8 : -8;
      select(order[Math.max(0, Math.min(order.length - 1, i < 0 ? 0 : i + step))]);
    };
    dlg = ide.ui.dialog({
      title: tr('Attach to Process'),
      body,
      width: 760,
      buttons: [
        { label: tr('Attach'), primary: true, run: () => { attachSelected(); return false; } },
        { label: tr('Cancel') },
        { label: tr('Refresh'), run: () => { load(); filter.focus(); return false; } },
      ],
    });
    dlg.el.classList.add('dbg-dialog', 'dbg-attach-dialog');
    dlg.el.id = 'dbgAttachDialog';
    render();
    load();
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

  // id: the process that stopped. again: a stop shown before (the process list), not checked as an exception stop again.
  async function onStopped(body, id, { again = false } = {}) {
    const s = sess;
    const p = s.procs.get(id);
    if (!p) return;
    p.stop = body;
    const threadId = body.threadId ?? 1;
    // The stopped thread's own name (MainThread, or a worker's) for the Frames header.
    const threads = reqTo(id, 'threads').then((r) => r.threads || [], () => []);
    let frames = [];
    try { ({ stackFrames: frames } = await reqTo(id, 'stackTrace', { threadId, startFrame: 0, levels: 200 })); } catch {}
    // An exception stop that is passed over leaves the session running (the controls never flicker) and goes on with
    // what resumed it, so a step is not turned into a run.
    if (!again && body.reason === 'exception' && sess === s && !(await wantExceptionStop(p, threadId, frames))) {
      if (sess === s && p.stop === body) {
        p.stop = null;
        reqTo(id, resumeAfterPassOver(p, frames), { threadId }).catch(() => {});
      }
      return;
    }
    if (sess !== s || p.stop !== body) return;
    // While another process's stop is shown, this one waits in the process list.
    if (suspended() && s.cur !== id) return renderFrames();
    s.cur = id;
    s.state = 'suspended';
    s.exceptionMode = p.exceptionMode || null;
    s.threadId = threadId;
    s.stopReason = body.reason;
    s.stopText = body.text || '';
    s.stopDescription = body.description || '';
    if (s.tempBp) {
      const p = s.tempBp.path;
      s.tempBp = null;
      sendBps(p);
    }
    updateControls();
    s.threadName = (await threads).find((th) => th.id === s.threadId)?.name || '';
    await toIdePaths(frames);
    if (sess !== s || s.state !== 'suspended' || s.cur !== id) return;
    s.frames = frames;
    if (!tw.isVisible()) tw.show();
    // The program's input is hidden with the console: stepping and editing continue in the editor.
    const hadInput = document.activeElement === con.input;
    showSub('debugger');
    if (hadInput) ide.editor?.focus();
    renderFrames();
    await selectFrame(Math.max(0, frames.findIndex((f) => f.source?.path)));
  }

  // debugpy reports frames by the long form of their path, while the project, its tabs and breakpoints may name a
  // folder by its 8.3 short name (C:\Users\RUNNER~1\…). Such frame paths are put back in the IDE's form, so a stop
  // shows in the tab already open rather than in a second one without the breakpoints.
  async function toIdePaths(frames) {
    const known = [...new Set([ide.root, ...ide.tabs.filter((t) => t.kind === 'file').map((t) => t.path), ...[...bps.values()].map((f) => f.path)]
      .filter((p) => p?.includes('~')))];
    if (!known.length || !frames.some((f) => f.source?.path)) return;
    const longs = await ide.api.invoke('debug:longPaths', known).catch(() => known);
    for (const f of frames) {
      const p = f.source?.path;
      let best = -1;
      longs.forEach((l, i) => { if (!samePath(l, known[i]) && isUnder(p, l) && (best < 0 || l.length > longs[best].length)) best = i; });
      if (best >= 0) f.source.path = known[best] + p.slice(longs[best].length);
    }
  }

  async function selectFrame(i) {
    if (!suspended()) return;
    const s = sess;
    s.frameIdx = i;
    renderFrames();
    const frame = s.frames[i];
    // A pause while debugpy is still starting the program stops with only library frames, which justMyCode hides:
    // nothing to show, rather than the text the Variables pane had before.
    if (!frame) { renderVars([]); renderWatches(); return; }
    if (frame.source?.path && !generatedFor(frame.source.path)) await ide.openFile(frame.source.path, { line: frame.line, focus: false });
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
    const p = sess.procs.get(sess.cur);
    p.resumedBy = command;
    p.resumeDepth = sess.frames.length;
    p.stop = null;
    setRunning();
    reqTo(p.id, command, { threadId }).catch((err) => con.append(`${tr('{command} failed: {error}', { command, error: remoteError(err) })}\n`, 'err'));
    if (command === 'continue') showNextStop();
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
    const java = /\.java$/i.test(frame.source?.path || '');
    const byName = new Map(vars.filter((v) => /^[A-Za-z_]\w*$/.test(v.name) && !SKIP_TYPES.has(v.type) && !(java && v.name === 'this')).map((v) => [v.name, v]));
    if (!byName.size) return [];
    const stop = Math.min(frame.line, model.getLineCount());
    const indent = (l) => model.getLineContent(l).search(/\S/);
    const stopIndent = indent(stop);
    let start = Math.max(1, stop - 300);
    // From the function's (or Java method's) first line.
    const header = java ? /^\s*[\w<>[\],.?@\s]*\b(?!(?:if|for|while|switch|catch|synchronized)\b)\w+\s*\([^;]*$/ : /^\s*(async\s+)?def\s/;
    for (let l = stop; l >= start; l--) {
      const t = model.getLineContent(l);
      if (header.test(t) && t.search(/\S/) < stopIndent) { start = l; break; }
    }
    const out = [];
    for (let l = start; l <= stop; l++) {
      const code = model.getLineContent(l).replace(/(["'])(?:\\.|(?!\1).)*\1/g, '""').replace(java ? /\/\/.*/ : /#.*/, '');
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
    loadExcBps();
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
  // Python's types, then Java's (main/features/debug-jvm.js names a value's type as IntelliJ IDEA does).
  const valueClass = (v) => (v.type === 'str' || v.type === 'String' ? 'str'
    : ['int', 'float', 'complex', 'bool', 'long', 'short', 'byte', 'double', 'boolean', 'char'].includes(v.type) ? 'num' : '');
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

  // parentRef: the variablesReference of the container the variable is in (a scope, a dict...), for setVariable.
  // scopeRef: the variablesReference of the scope other than Locals (Globals) that holds the variable itself, directly
  // or in one of its groups ("function variables"); 0 for anything else.
  function varNode(v, parentPath, depth, shownName = v.name, parentRef = 0, scopeRef = 0) {
    const nodePath = `${parentPath}/${v.name}`;
    const wrap = el('div', 'dbg-node');
    const row = el('div', 'dbg-var');
    row.style.paddingLeft = `${depth * 16 + 4}px`;
    row.dataset.key = nodePath;
    if (reselectKey === nodePath) { row.classList.add('selected'); reselectKey = null; }
    const expandable = v.variablesReference > 0;
    const arrow = el('span', 'dbg-arrow', expandable ? '▸' : '');
    // Scopes and debugpy's "special variables"/"function variables" buckets have no value of their own.
    const group = !v.error && (v.group || (expandable && !v.type && !v.value));
    const tip = `${v.name} = ${v.value ?? v.error ?? ''}`;
    const expr = v.evaluateName || (parentPath === 'W' ? v.name : null);
    if (group) {
      row.classList.add('dbg-group');
      row.append(arrow, el('span', 'dbg-name', groupLabel(v.name)));
    } else {
      row.append(arrow, v.label ? el('span', 'dbg-name', v.label) : data('dbg-name', shownName, tip));
    }
    if (v.error) row.append(el('span', 'dbg-eq', ' = '), data('dbg-err', v.error, tip));
    else if (!group) {
      row.append(el('span', 'dbg-eq', ' = '));
      if (v.type) row.append(data('dbg-type', `{${v.type}} `));
      row.append(data(`dbg-value ${valueClass(v)}`, v.value ?? '', tip));
      for (const fn of varDecorators) { try { fn(row, v, expr); } catch (err) { console.error(err); } }
    }
    if (!group) {
      row._var = { v, path: nodePath, parentRef, scopeRef, expr };
      row.addEventListener('mousedown', () => selectVarRow(row));
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
      const childScope = v.scope ? v.variablesReference : group ? scopeRef : 0;
      kids.replaceChildren(...children.map((c) => varNode(c, nodePath, depth + 1, c.name, v.variablesReference, childScope)));
    };
    row.onclick = () => toggle();
    if (expandedVars.has(nodePath)) toggle(true);
    return wrap;
  }

  let varsList, framesList, watchesList, threadLabel, procSelect, excBar;

  // ---------- Set Value, Copy Value, Copy Name, Add to Watches ----------
  // Rows of the Variables and Watches lists carry row._var = {v, path, parentRef, expr}: the DAP variable, its key in
  // the tree, its container's variablesReference and the expression that names it (evaluateName, or the watch).
  let reselectKey = null; // the row to select again once the tree is rebuilt after Set Value
  function selectVarRow(row) {
    const list = row.closest('.dbg-list');
    if (list !== varsList) return;
    for (const r of list.querySelectorAll('.dbg-var')) r.classList.toggle('selected', r === row);
  }
  const selectedVarRow = (list) => list.querySelector(list === watchesList ? '.dbg-watch.selected > .dbg-var' : '.dbg-var.selected');
  // The selected row of the Variables or Watches list that has the keyboard.
  function keyboardVarRow() {
    const list = document.activeElement;
    if (!list || (list !== varsList && list !== watchesList)) return null;
    const row = selectedVarRow(list);
    return row?._var ? row : null;
  }
  const canSet = (info) => !!info && suspended() && !info.v.error && !!(info.expr || info.parentRef);

  // setExpression where the row has an expression, as it reports errors; setVariable on the container otherwise. A
  // variable of Globals is set through its scope: pydevd runs an assignment with the frame's locals, so in a function
  // it would make a local of that name and leave the global as it was. setVariable reports no failure, so the value
  // is evaluated first.
  async function setValue({ v, expr, parentRef, scopeRef }, value) {
    try {
      if (scopeRef) {
        const r = await evaluate(value, 'watch');
        if (r.error) return { error: tr('Cannot set the value: {error}', { error: r.error }) };
        await req('setVariable', { variablesReference: scopeRef, name: v.name, value });
      } else if (expr) await req('setExpression', { expression: expr, value, frameId: currentFrame()?.id });
      else await req('setVariable', { variablesReference: parentRef, name: v.name, value });
      return {};
    } catch (err) {
      // debugpy names only the assignment ("Error executing: i = (x)"); the value's own error says what is wrong.
      const r = await evaluate(value, 'watch');
      return { error: tr('Cannot set the value: {error}', { error: r.error || remoteError(err) }) };
    }
  }

  // debugpy shortens values in the tree (a string inside a dict is cut at 128 characters into text that is still valid
  // Python); the clipboard context gives the whole value.
  async function fullValue({ v, expr }) {
    if (!expr || v.error || !suspended()) return v.error ?? v.value ?? '';
    const r = await evaluate(expr, 'clipboard');
    return r.error ? v.value ?? '' : r.value;
  }

  // PyCharm's Set Value… (F2): the value turns into a field in its row, holding the whole value; Enter assigns the
  // Python expression typed there and the views are refreshed, Esc or leaving the field cancels.
  async function editValue(row) {
    const info = row?._var;
    if (!canSet(info) || !row.querySelector('.dbg-value')) return;
    const s = sess;
    const initial = String(await fullValue(info));
    const shown = row.querySelector('.dbg-value');
    if (sess !== s || !suspended() || !shown || !row.isConnected) return;
    const list = row.closest('.dbg-list');
    const field = el('input', 'dbg-value-edit');
    field.id = 'dbgSetValue';
    field.value = initial;
    field.spellcheck = false;
    const error = data('dbg-err dbg-set-error', '');
    error.id = 'dbgSetValueError';
    for (const type of ['mousedown', 'click']) field.addEventListener(type, (e) => e.stopPropagation());
    shown.replaceWith(field);
    field.after(error);
    let busy = false;
    const stop = () => removeEventListener('keydown', onKey, true);
    const cancel = (refocus) => {
      stop();
      if (field.isConnected) { field.replaceWith(shown); error.remove(); }
      if (refocus) list.focus();
    };
    const commit = async () => {
      const value = field.value.trim();
      if (value === initial.trim()) return cancel(true);
      busy = true;
      const res = await setValue(info, value);
      busy = false;
      if (sess !== s || !suspended() || !field.isConnected) return stop();
      // The keyboard stays wherever the user moved it meanwhile.
      const hadKeys = document.activeElement === field;
      if (res.error && hadKeys) {
        error.textContent = `  ${res.error}`;
        error.title = res.error;
        return;
      }
      stop();
      if (res.error) return cancel(false);
      reselectKey = info.path;
      if (hadKeys) list.focus();
      await refreshAfterEval();
      reselectKey = null;
    };
    // Ahead of the global keymap, whose Esc would move the keyboard to the editor.
    const onKey = (e) => {
      if (!field.isConnected) return stop();
      if (document.activeElement !== field || e.isComposing || (e.key !== 'Enter' && e.key !== 'Escape')) return;
      e.preventDefault();
      e.stopPropagation();
      if (busy) return;
      if (e.key === 'Escape') cancel(true);
      else if (field.value.trim()) commit();
    };
    addEventListener('keydown', onKey, true);
    field.onblur = () => setTimeout(() => { if (!busy && field.isConnected && document.activeElement !== field) cancel(false); });
    field.focus();
    field.select();
  }

  const copyValue = async (info) => ide.api.invoke('clipboard:writeText', String(await fullValue(info)));

  function varMenu(row, x, y) {
    const info = row._var;
    ide.ui.contextMenu(x, y, [
      { label: tr('Set Value…'), keyAction: 'SetValue', disabled: !canSet(info), run: () => editValue(row) },
      { label: tr('Copy Value'), keyAction: 'CopyValue', run: () => copyValue(info) },
      { label: tr('Copy Name'), run: () => ide.api.invoke('clipboard:writeText', info.v.name) },
      { separator: true },
      { label: tr('Add to Watches'), disabled: info.path === `W/${info.v.name}`, run: () => addWatch(info.expr || info.v.name) },
    ]);
  }
  // Right-click on a row, or the context-menu key on the list (for its selected row).
  function onVarContextMenu(e) {
    const list = e.currentTarget;
    const fromKeys = e.target === list;
    const row = fromKeys ? selectedVarRow(list) : e.target.closest?.('.dbg-var');
    if (!row?._var || row.querySelector('.dbg-value-edit')) return;
    e.preventDefault();
    const r = row.getBoundingClientRect();
    varMenu(row, fromKeys ? r.left + 24 : e.clientX, fromKeys ? r.bottom : e.clientY);
  }

  // vars: null while running, [] when no session
  function renderVars(vars, extraScopes = []) {
    if (!varsList) return;
    if (!vars) return varsList.replaceChildren(el('div', 'dbg-empty', sess ? tr('Variables are not available while running') : tr('Not suspended')));
    if (!sess) return varsList.replaceChildren(el('div', 'dbg-empty', tr('Not debugging. Start with {keys}', { keys: 'Shift+F9' })));
    const path = currentFrame()?.source?.path;
    const generated = generatedFor(path);
    varsList.replaceChildren(
      ...vars.map((v) => varNode(v, 'L', 0, generated?.variableLabel?.(path, v.name) || v.name, sess.scopes?.[0]?.variablesReference || 0)),
      ...extraScopes.map((sc) => varNode({ name: sc.name, group: true, scope: true, variablesReference: sc.variablesReference }, 'S', 0)),
    );
    if (!vars.length && !extraScopes.length) varsList.appendChild(el('div', 'dbg-empty', tr('No variables')));
  }

  // DAP 'stopped' reasons, shown next to the thread name.
  const STOP_REASONS = { breakpoint: tr('breakpoint'), step: tr('step'), pause: tr('pause'), exception: tr('exception'), entry: tr('entry'),
    goto: tr('goto'), 'function breakpoint': tr('function breakpoint'), 'data breakpoint': tr('data breakpoint') };
  const stopReasonLabel = (reason) => (!reason ? tr('paused') : Object.hasOwn(STOP_REASONS, reason) ? STOP_REASONS[reason] : reason);

  // At a stop on an exception, the Variables pane names it: "ValueError: empty text", and whether it suspended where
  // it was raised or as it ended the program.
  function renderException() {
    const on = suspended() && sess.stopReason === 'exception';
    excBar.classList.toggle('hidden', !on);
    if (!on) return excBar.replaceChildren();
    const text = sess.stopDescription ? `${sess.stopText}: ${sess.stopDescription}` : sess.stopText;
    const mode = { always: tr('On raise'), unhandled: tr('On termination') }[sess.exceptionMode];
    excBar.replaceChildren(el('span', 'dbg-exc-dot'), data('dbg-exc-text', text, text), ...(mode ? [el('span', 'dbg-exc-mode muted', mode)] : []));
  }

  const procLabel = (p) => {
    const name = p.name && !p.name.startsWith('-') ? basename(p.name) : p.child ? tr('Subprocess') : tr('Main process');
    return p.pid ? tr('{name} (pid {pid})', { name, pid: p.pid }) : name;
  };
  // The session's processes, once the program has started one: each with its state, the shown one selected.
  function renderProcs() {
    const list = sess ? [...sess.procs.values()] : [];
    procSelect.classList.toggle('hidden', list.length < 2);
    procSelect.replaceChildren(...(list.length < 2 ? [] : list.map((p) => {
      const o = el('option', null, `${procLabel(p)} · ${p.stop ? stopReasonLabel(p.stop.reason) : tr('Running')}`);
      o.selected = p.id === sess.cur;
      o.dataset.userText = '';
      return o;
    })));
  }

  function renderFrames() {
    if (!framesList) return;
    renderProcs();
    renderException();
    threadLabel.textContent = !sess ? '' : suspended() ? `${sess.threadName ? `${sess.threadName} · ` : ''}${stopReasonLabel(sess.stopReason)}` : tr('Running');
    if (!suspended()) {
      return framesList.replaceChildren(el('div', 'dbg-empty', sess ? tr('Frames are not available in non-suspended state') : tr('Not debugging')));
    }
    framesList.replaceChildren(...sess.frames.map((f, i) => {
      const row = el('div', 'dbg-frame' + (i === sess.frameIdx ? ' selected' : '') + (f.source?.path ? '' : ' muted'));
      const generated = generatedFor(f.source?.path)?.label(f.source.path, f.line);
      row.append(data('dbg-frame-name', f.name), data('dbg-frame-loc', `, ${generated || `${f.source?.path ? basename(f.source.path) : f.source?.name || '?'}:${f.line}`}`));
      row.title = generated || f.source?.path || '';
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
        { label: tr('Evaluate'), primary: true, run: async () => {
          const expr = input.value.trim();
          if (!expr) return false;
          const r = await evaluate(expr, 'repl');
          result.replaceChildren(varNode({ ...r, name: 'result', label: tr('result') }, `E/${expr}`, 0));
          input.select();
          return false;
        } },
        { label: tr('Close') },
        { label: tr('Add Watch'), run: () => { addWatch(input.value); return false; } },
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
  function excSummary(bp) {
    const box = el('span', 'dbg-bps-summary');
    const modes = [bp.onRaise && tr('On raise'), bp.onTerminate && tr('On termination')].filter(Boolean);
    if (modes.length) box.append(el('span', 'muted', `  ${modes.join(', ')}`));
    if (bp.condition) box.append(data('muted', `  [${bp.condition}]`));
    return box;
  }

  // An exception breakpoint's settings, as in PyCharm's Breakpoints dialog. debugpy debugs only project code, so
  // "Ignore library files" is always on: an exception raised in a library suspends where it reaches project code.
  function excFields(bp, onChange) {
    const box = el('div', 'dbg-bp-fields');
    const en = checkRow(tr('Enabled'), bp.enabled);
    const raise = checkRow(tr('On raise'), bp.onRaise);
    const term = checkRow(tr('On termination'), bp.onTerminate);
    const lib = checkRow(tr('Ignore library files'), true);
    lib.cb.disabled = true;
    lib.row.title = tr('debugpy debugs only project code: an exception raised in a library suspends where it reaches project code.');
    const cond = textInput('dbgExcCondition', bp.condition, tr('e.g. "bad" in str(__exception__[1])'));
    en.cb.id = 'dbgExcEnabled';
    raise.cb.id = 'dbgExcOnRaise';
    term.cb.id = 'dbgExcOnTerminate';
    const props = () => ({ enabled: en.cb.checked, onRaise: raise.cb.checked, onTerminate: term.cb.checked, condition: cond.value.trim() });
    for (const c of [en, raise, term]) c.cb.onchange = () => onChange(props());
    cond.onchange = () => onChange(props());
    raise.row.classList.add('dbg-indent');
    term.row.classList.add('dbg-indent');
    box.append(en.row, el('div', 'dbg-bp-label', tr('Activation policy:')), raise.row, term.row, lib.row, fieldRow(tr('Condition:'), cond),
      el('div', 'dbg-bp-hint', tr('__exception__ is (type, value, traceback) of the exception.')));
    return { el: box };
  }

  // Python Line Breakpoints, then Python Exception Breakpoints. select: {path, line} of the line breakpoint to show first.
  function breakpointsDialog(select = null) {
    closeBpPopup?.();
    const body = el('div', 'dbg-bps');
    const side = el('div', 'dbg-bps-side');
    const tools = el('div', 'dbg-bps-tools');
    const addBtn = el('button', 'dbg-mini', '+');
    addBtn.id = 'dbgExcAdd';
    addBtn.title = tr('Add Python Exception Breakpoint');
    const rmBtn = el('button', 'dbg-mini');
    rmBtn.appendChild(ide.icon('remove'));
    rmBtn.id = 'dbgBpListRemove';
    rmBtn.title = `${tr('Remove')} (Delete)`;
    tools.append(addBtn, rmBtn);
    const addInput = textInput('dbgExcClass', '', tr('Exception class, e.g. ValueError or myapp.errors.AppError'));
    addInput.classList.add('dbg-exc-input', 'hidden');
    const addError = el('div', 'dbg-exc-error hidden');
    addError.id = 'dbgExcClassError';
    const list = el('div', 'dbg-bps-list');
    list.id = 'dbgBpList';
    side.append(tools, addInput, addError, list);
    const detail = el('div', 'dbg-bps-detail');
    body.append(side, detail);
    const entries = () => [
      ...allBps().sort((a, b) => a.path.localeCompare(b.path) || a.bp.line - b.bp.line).map((e) => ({ kind: 'line', ...e })),
      ...excBps.map((bp) => ({ kind: 'exception', bp })),
    ];
    let current = (select && allBps().find((e) => samePath(e.path, select.path) && e.bp.line === select.line)?.bp) || null;
    let shown = null; // the breakpoint whose fields the detail pane holds, so edits there are not rebuilt under the caret
    let fromDetail = false;
    let dlg;
    const toggle = (e, enabled) => (e.kind === 'line' ? setBp(e.path, e.bp.line, { enabled }) : setExcBp(e.bp, { enabled }));
    const remove = (e) => (e.kind === 'line' ? removeBp(e.path, e.bp.line) : removeExcBp(e.bp));
    const removable = (e) => !!e && (e.kind === 'line' || e.bp.type !== null);
    const row = (e) => {
      const r = el('div', 'dbg-bps-row' + (e.bp === current ? ' selected' : ''));
      r.dataset.key = e.kind === 'line' ? `L${e.path.toLowerCase()}:${e.bp.line}` : `E${e.bp.type ?? ''}`;
      const cb = el('input');
      cb.type = 'checkbox';
      cb.checked = e.bp.enabled;
      cb.tabIndex = -1;
      cb.onclick = (ev) => { ev.stopPropagation(); toggle(e, cb.checked); };
      if (e.kind === 'line') {
        r.append(cb, el('span', `dbg-bp-dot${bpClasses(e.bp)}`), data(null, `${basename(e.path)}:${e.bp.line}`), bpSummary(e.bp));
        r.ondblclick = () => { dlg.close(); ide.openFile(e.path, { line: e.bp.line }); };
      } else {
        r.append(cb, el('span', `dbg-exc-dot${e.bp.enabled ? '' : ' disabled'}`),
          e.bp.type === null ? el('span', null, excName(e.bp)) : data(null, e.bp.type), excSummary(e.bp));
      }
      r.onclick = () => { current = e.bp; render(); };
      return r;
    };
    const render = () => {
      const all = entries();
      if (current && !all.some((e) => e.bp === current)) current = null;
      current ||= all[0]?.bp || null;
      const lines = all.filter((e) => e.kind === 'line');
      const excs = all.filter((e) => e.kind === 'exception');
      list.replaceChildren(
        el('div', 'dbg-bps-group', tr('Python Line Breakpoints ({count})', { count: lines.length })), ...lines.map(row),
        el('div', 'dbg-bps-group', tr('Python Exception Breakpoints ({count})', { count: excs.length })), ...excs.map(row),
      );
      const entry = all.find((e) => e.bp === current);
      rmBtn.disabled = !removable(entry);
      if (fromDetail && shown === current) return;
      shown = current;
      detail.replaceChildren();
      if (!entry) return;
      const actions = el('div', 'dbg-bps-actions');
      if (entry.kind === 'line') {
        const { path, bp } = entry;
        const title = el('div', 'dbg-bps-title', `${ide.util.rel(path)}:${bp.line}`);
        title.dataset.userText = '';
        const fields = bpFields(bp, (props) => {
          fromDetail = true;
          try { setBp(path, bp.line, props); } finally { fromDetail = false; }
        }, { condition: 'dbgBpListCondition', hit: 'dbgBpListHit', log: 'dbgBpListLog' }, path);
        const go = el('button', 'secondary', tr('Go to Source'));
        go.onclick = () => { dlg.close(); ide.openFile(path, { line: bp.line }); };
        actions.append(go);
        detail.append(title, fields.el);
      } else {
        const { bp } = entry;
        const title = el('div', 'dbg-bps-title', excName(bp));
        if (bp.type !== null) title.dataset.userText = '';
        const fields = excFields(bp, (props) => {
          fromDetail = true;
          try { setExcBp(bp, props); } finally { fromDetail = false; }
        });
        detail.append(title, fields.el);
      }
      if (removable(entry)) {
        const rm = el('button', 'secondary', tr('Remove'));
        rm.id = 'dbgBpRemove';
        rm.onclick = () => remove(entry);
        actions.append(rm);
      }
      detail.append(actions);
    };
    const removeCurrent = () => { const e = entries().find((x) => x.bp === current); if (removable(e)) remove(e); };
    ide.ui.listKeys(list, { rows: '.dbg-bps-row', select: (r) => r.click(), open: () => {} });
    list.addEventListener('keydown', (ev) => {
      if (ev.target !== list) return;
      const e = entries().find((x) => x.bp === current);
      if (ev.key === 'Delete') { ev.preventDefault(); removeCurrent(); } else if (ev.key === ' ' && e) { ev.preventDefault(); toggle(e, !e.bp.enabled); }
    });
    rmBtn.onclick = removeCurrent;

    // PyCharm's + › Python Exception Breakpoint: the class is typed in a field above the list.
    const hideAdd = () => { addInput.classList.add('hidden'); addError.classList.add('hidden'); list.focus(); };
    addBtn.onclick = () => { addInput.value = ''; addError.classList.add('hidden'); addInput.classList.remove('hidden'); addInput.focus(); };
    const commitAdd = () => {
      const type = addInput.value.trim();
      if (!type) return hideAdd();
      if (!EXC_CLASS.test(type)) {
        addError.textContent = tr('Not a Python class name: {name}', { name: type });
        addError.classList.remove('hidden');
        return;
      }
      current = addExcBp(type);
      render();
      hideAdd();
    };
    // Ahead of the dialog's own keys (registered before it): Enter and Esc in the class field add or cancel instead
    // of closing the dialog.
    const addKeys = (ev) => {
      if (ev.target !== addInput || ev.isComposing || (ev.key !== 'Enter' && ev.key !== 'Escape')) return;
      ev.preventDefault();
      ev.stopImmediatePropagation();
      if (ev.key === 'Enter') commitAdd(); else hideAdd();
    };
    addEventListener('keydown', addKeys, true);
    bpListener = render;
    render();
    dlg = ide.ui.dialog({
      title: tr('Breakpoints'),
      body,
      width: 720,
      buttons: [{ label: tr('Done'), primary: true, run: () => { document.activeElement?.blur?.(); } }],
      onClose: () => {
        removeEventListener('keydown', addKeys, true);
        if (bpListener === render) bpListener = null;
      },
    });
    dlg.el.classList.add('dbg-dialog');
    list.focus();
  }

  // ---------- tool window ----------
  let con, tw, subTabs, subPanes, subSep, shownSub = 'debugger', lastFile = null, lastCfg = {};
  let lastRun = null; // Rerun: debugs the last file again or attaches to the last process again
  const btns = {};

  function showSub(which) {
    if (!subTabs[which]) which = 'console';
    shownSub = which;
    for (const [k, b] of Object.entries(subTabs)) b.classList.toggle('active', k === which);
    for (const [k, p] of Object.entries(subPanes)) p.classList.toggle('hidden', k !== which);
  }

  // A plugin's sub-tabs of the session (debugFile's cfg.tabs: [{id, title, select?, mount(host, tab) -> {dispose?}}]),
  // after Threads & Variables and Console, as PyCharm shows a debugged test run's Test Results there. They belong to
  // the session that started with them and stay after it ends, until the next session starts. tab: {show(), setIcon}.
  let sessionTabs = [];
  function setSessionTabs(list = []) {
    for (const t of sessionTabs.splice(0)) {
      t.closed = true;
      try { t.mounted?.dispose?.(); } catch (err) { ide.log.error(`debugger tab ${t.id}: ${err?.stack || err}`); }
      t.button.remove();
      t.pane.remove();
      delete subTabs[t.key];
      delete subPanes[t.key];
    }
    for (const def of list) {
      const key = `tab:${def.id}`;
      const icon = el('span', 'dbg-subtab-icon hidden');
      const button = el('button', 'dbg-subtab dbg-plugin-tab');
      button.dataset.tab = def.id;
      button.append(icon, el('span', null, def.title));
      const pane = el('div', 'dbg-plugin-pane hidden');
      pane.dataset.tab = def.id;
      const t = { id: def.id, key, button, pane, closed: false, select: !!def.select };
      const handle = {
        show() { if (t.closed) return false; tw.show(); showSub(key); return true; },
        setIcon(name, cls = '') { icon.replaceChildren(...(name ? [ide.icon(name)] : [])); icon.className = `dbg-subtab-icon ${cls}${name ? '' : ' hidden'}`; },
      };
      button.onclick = () => showSub(key);
      subSep.before(button);
      subPanes.console.after(pane);
      subTabs[key] = button;
      subPanes[key] = pane;
      sessionTabs.push(t);
      try { t.mounted = def.mount(pane, handle) || null; } catch (err) { ide.log.error(`debugger tab ${def.id}: ${err?.stack || err}`); }
    }
    showSub(sessionTabs.find((t) => t.select)?.key || shownSub);
  }

  function pane(title, actions = []) {
    const p = el('div', 'dbg-pane');
    const head = el('div', 'dbg-pane-head');
    const label = el('span', null, title);
    head.appendChild(label);
    head.appendChild(el('span', 'spacer'));
    for (const a of actions) {
      const b = el('button', 'dbg-mini');
      b.appendChild(ide.icon(a.icon));
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
      subSep = el('span', 'dbg-sep');
      bar.append(subTabs.debugger, subTabs.console, subSep);
      // action: the action whose current shortcut the tooltip shows.
      const mk = (id, icon, title, run, cls = '', action = null) => {
        const b = el('button', `dbg-btn ${cls}`);
        b.appendChild(ide.icon(icon));
        b.id = `dbg${id}`;
        if (action) ide.keymap.tooltip(b, title, action);
        else b.title = title;
        b.onclick = run;
        bar.appendChild(b);
        btns[id] = b;
      };
      mk('Rerun', 'rerun', tr('Rerun'), () => lastRun?.(), 'green');
      mk('Resume', 'resume', tr('Resume Program'), () => step('continue'), 'green', 'Resume');
      mk('Pause', 'pause', tr('Pause Program'), pause);
      mk('Stop', 'runStop', tr('Stop'), stopDebug, 'red', 'StopDebug');
      bar.appendChild(el('span', 'dbg-sep'));
      mk('StepOver', 'stepOver', tr('Step Over'), () => step('next'), 'blue', 'StepOver');
      mk('StepInto', 'stepInto', tr('Step Into'), () => step('stepIn'), 'blue', 'StepInto');
      mk('StepOut', 'stepOut', tr('Step Out'), () => step('stepOut'), 'blue', 'StepOut');
      mk('RunToCursor', 'runToCursor', tr('Run to Cursor'), runToCursor, 'blue', 'RunToCursor');
      bar.appendChild(el('span', 'dbg-sep'));
      mk('Evaluate', 'evaluate', tr('Evaluate Expression'), evaluateDialog, '', 'EvaluateExpression');
      mk('Breakpoints', 'breakpoints', tr('View Breakpoints'), () => breakpointsDialog(), 'red', 'ViewBreakpoints');

      const vars = el('div', 'dbg-panes');
      const frames = pane(tr('Frames'));
      threadLabel = el('span', 'dbg-thread muted');
      frames.head.insertBefore(threadLabel, frames.head.children[1]);
      procSelect = el('select', 'dbg-procs hidden');
      procSelect.id = 'dbgProcesses';
      procSelect.title = tr('Processes');
      procSelect.onchange = () => showProc([...sess.procs.keys()][procSelect.selectedIndex]);
      frames.head.insertBefore(procSelect, threadLabel);
      framesList = frames.list;
      framesList.id = 'dbgFrames';
      ide.ui.listKeys(framesList, { rows: '.dbg-frame', select: (row) => row.click() });
      const variables = pane(tr('Variables'));
      varsList = variables.list;
      varsList.id = 'dbgVars';
      excBar = el('div', 'dbg-exc hidden');
      excBar.id = 'dbgException';
      variables.p.insertBefore(excBar, varsList);
      // Variables: Right/Left expand and collapse a value, Left on a child goes to its parent.
      ide.ui.listKeys(varsList, {
        rows: '.dbg-var:not(.muted)',
        expanded: (row) => ({ '▾': true, '▸': false })[row.querySelector('.dbg-arrow')?.textContent] ?? null,
        parent: (row) => (row.parentElement.parentElement.classList.contains('dbg-kids') ? row.parentElement.parentElement.previousElementSibling : null),
      });
      const watchPane = pane(tr('Watches'), [
        { id: 'dbgWatchAdd', icon: 'add', title: tr('New Watch'), run: () => { watchInput.classList.remove('hidden'); watchInput.focus(); } },
        { id: 'dbgWatchRemove', icon: 'remove', title: `${tr('Remove Watch')} (Delete)`, run: () => removeWatch() },
      ]);
      watchesList = watchPane.list;
      watchesList.id = 'dbgWatches';
      for (const list of [varsList, watchesList]) list.addEventListener('contextmenu', onVarContextMenu);
      watchesList.tabIndex = 0;
      watchesList.onkeydown = (e) => { if (e.key === 'Delete' && e.target === watchesList) { e.preventDefault(); removeWatch(); } };
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
          if (!sess || sess.attach) return;
          con.append(`${text}\n`, 'cmd');
          if (sess.id) ide.proc.input(sess.id, `${text}\n`);
          else sess.typed.push(text);
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
    // Stop on an attached process detaches from it, as in PyCharm.
    ide.keymap.tooltip(btns.Stop, sess?.attach ? tr('Detach') : tr('Stop'), 'StopDebug');
    btns.Rerun.disabled = !lastRun;
    for (const k of ['StepOver', 'StepInto', 'StepOut', 'RunToCursor', 'Evaluate']) btns[k].disabled = !susp;
    debugBtn.classList.toggle('active', active);
    tw.setBadge(susp ? '●' : '');
    if (active !== lastActive) { lastActive = active; ide.emit('debugSessionChanged', active); }
  }

  // ---------- toolbar, actions ----------
  const debugBtn = el('button', 'tb-icon dbg-tb-btn');
  debugBtn.id = 'debugBtn';
  ide.keymap.tooltip(debugBtn, tr('Debug'), 'Debug');
  debugBtn.appendChild(ide.icon('runDebug', '🐞'));
  ide.registerToolbarItem({ order: 80, el: debugBtn });

  // The run configuration type that debugs a file its own way through its debugTarget: pytest for a test file, a visual
  // script (also in a viewer tab). Such a file is never debugged as a plain script, as with PyCharm's Current File.
  // A type with its own debug(cfg) (Java Application) debugs its selected configuration too, as IntelliJ IDEA does.
  const claimingType = (path) => (path ? [...(ide.run?.types.values() || [])].find((t) => (t.debugTarget || t.debug) && t.forFile?.(path)) : null);
  function debugCurrent() {
    const selected = ide.run?.selected?.();
    if (selected && ide.run.types.get(selected.type)?.debug) return ide.run.debugConfig(selected);
    const tab = ide.activeTab();
    const type = claimingType(tab?.path);
    if (type) return ide.run.debugConfig({ ...type.defaults(), ...type.forFile(tab.path) });
    // A scratch file (scratches plugin) runs in the project root, as in PyCharm.
    if (tab?.kind === 'file' && tab.path.endsWith('.py')) return debugFile(tab.path, ide.root && ide.scratches?.isScratch(tab.path) ? { cwd: ide.root } : {});
    if (lastFile) return lastCfg.rerun ? lastCfg.rerun() : debugFile(lastFile, lastCfg);
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
    { id: 'AttachToProcess', title: tr('Attach to Process…'), keys: 'Ctrl+Alt+F5', run: attachDialog },
    { id: 'ToggleLineBreakpoint', title: tr('Toggle Line Breakpoint'), keys: 'Ctrl+F8', when: hasFile,
      run: () => toggleBp(activeFile().path, ide.editor.getPosition().lineNumber) },
    { id: 'ViewBreakpoints', title: tr('View Breakpoints…'), keys: 'Ctrl+Shift+F8', run: viewOrEditBreakpoint },
    { id: 'StepOver', title: tr('Step Over'), keys: 'F8', when: suspended, run: () => step('next') },
    // F7 in a focused diff tab is Next Difference (compare plugin), as in PyCharm, also while suspended.
    { id: 'StepInto', title: tr('Step Into'), keys: 'F7', when: () => suspended() && !ide.compare?.diffFocused(), run: () => step('stepIn') },
    { id: 'StepOut', title: tr('Step Out'), keys: 'Shift+F8', when: suspended, run: () => step('stepOut') },
    { id: 'Resume', title: tr('Resume Program'), keys: 'F9', when: suspended, run: () => step('continue') },
    { id: 'Pause', title: tr('Pause Program'), when: () => sess?.state === 'running', run: pause },
    { id: 'RunToCursor', title: tr('Run to Cursor'), keys: 'Alt+F9', when: suspended, run: runToCursor },
    { id: 'EvaluateExpression', title: tr('Evaluate Expression…'), keys: 'Alt+F8', when: suspended, run: evaluateDialog },
    // In the Variables or Watches list, for its selected row.
    { id: 'SetValue', title: tr('Set Value…'), keys: 'F2', when: () => canSet(keyboardVarRow()?._var), run: () => editValue(keyboardVarRow()) },
    { id: 'CopyValue', title: tr('Copy Value'), keys: 'Ctrl+C', when: () => !!keyboardVarRow() && !String(getSelection()).trim(),
      run: () => { const row = keyboardVarRow(); if (row) copyValue(row._var); } },
  ].forEach(ide.registerAction);
  // Registered after every feature has loaded so it takes precedence over run's Ctrl+F2, but only while debugging.
  ide.on('ready', () => ide.registerAction({ id: 'StopDebug', title: tr('Stop Debugging'), keys: 'Ctrl+F2', when: () => !!sess, run: stopDebug }));
  // A file a configuration type claims has that type's own Debug entry (Debug 'pytest in …').
  ide.registerTreeAction({ title: tr("Debug '…'"), when: (e) => !e.dir && e.name.endsWith('.py') && !claimingType(e.path), run: (e) => debugFile(e.path) });

  // PyCharm's Settings › Build, Execution, Deployment › Python Debugger. Off, the Python processes a debugged program
  // starts run without the debugger (debugpy --configure-subProcess False; an attached process's are let go).
  (ide.settingsPages ||= []).push({
    id: 'python-debugger', title: () => tr('Python Debugger'), defaults: { [SUBPROCESS_SETTING]: true },
    keywords: 'debugger subprocess multiprocessing child process attach automatically 디버거 하위 프로세스 자동 연결',
    mount(host, ctx) {
      const sec = ctx.ui.section(host, tr('Python Debugger'));
      sec.appendChild(ctx.ui.checkbox(SUBPROCESS_SETTING, tr('Attach to subprocess automatically while debugging')));
      sec.appendChild(el('div', 'muted settings-note', tr('Breakpoints also suspend the Python processes a debugged program starts (subprocess, multiprocessing). Off, they run without the debugger.')));
    },
  });

  // evaluate(expression, context) runs in the selected frame and resolves {value, type} or {error}.
  // 'debugContextChanged' fires when the selected frame changes or the program resumes or ends.
  ide.debugger = {
    debugFile,
    debugJvm,
    attachToProcess,
    isActive: () => !!sess,
    isSuspended: suspended,
    evaluate: (expression, context = 'repl') => (suspended() ? evaluate(expression, context) : Promise.resolve({ error: tr('Not suspended') })),
    addVariableDecorator: (fn) => varDecorators.push(fn),
    // While suspended: why it stopped (an exception's type in text, its message in description), the stack and the
    // selected frame's index; else null.
    stopped: () => (suspended() ? { reason: sess.stopReason, text: sess.stopText, description: sess.stopDescription, index: sess.frameIdx,
      frames: sess.frames.map((f) => ({ id: f.id, name: f.name, line: f.line, path: f.source?.path || null })) } : null),
    registerGeneratedSource: (source) => generatedSources.push(source),
    // Sends a file's breakpoints to the running session again (a generated source's changed).
    sendBreakpoints: sendBps,
    // A request of the JVM session being debugged (redefineClasses for HotSwap); rejects when none runs.
    jvmRequest: (command, args) => (sess?.jvm && sess.id != null ? ide.api.invoke('debug:request', sess.id, command, args) : Promise.reject(new Error(tr('No Java debug session')))),
  };
  window.__debugger = { state: () => sess && { id: sess.id, attach: sess.attach || null, state: sess.state, frameIdx: sess.frameIdx, frames: sess.frames.map((f) => ({ name: f.name, line: f.line, path: f.source?.path })),
    cur: sess.cur, procs: [...sess.procs.values()].map((p) => ({ id: p.id, pid: p.pid, child: p.child, stopped: !!p.stop })) }, breakpoints: () => allBps().map(({ path, bp }) => ({ path, ...bp })) };
})();
