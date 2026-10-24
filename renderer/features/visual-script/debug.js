// Debugging a visual script on its nodes. index.js's run configuration type debugs the generated Python with debugpy
// (debugTarget) and hands the compile result here (VS.debugSession). This file keeps the breakpoints of each .pyflow
// (on nodes, in the visualScript.breakpoints setting, not in the file), turns them into line breakpoints of the
// generated file through the debugger's generated-source hook, shows where the program is paused on the canvas, marks
// the node of an uncaught exception and gives the editor the values of pins while paused.
(function (root) {
  const VS = root.PyideVisualScript || (root.PyideVisualScript = {});
  const ide = root.ide;
  const { basename, samePath } = ide.util;
  const tr = (text, vars) => VS.tr(text, vars);

  const BPS = 'visualScript.breakpoints'; // {path: [nodeIds]}
  const CONDITIONS = 'visualScript.breakpointConditions'; // {path: {nodeId: condition}}
  const views = new Set(); // {view, path} of every open canvas

  // ---------- breakpoints ----------
  const keyIn = (obj, path) => Object.keys(obj).find((k) => samePath(k, path));
  function breakpoints(path) {
    const all = ide.settings.get(BPS, {}) || {};
    const conds = ide.settings.get(CONDITIONS, {}) || {};
    const k = keyIn(all, path);
    const c = conds[keyIn(conds, path)] || {};
    return (k ? all[k] : []).map((node) => ({ node, condition: c[node] || '' }));
  }
  function store(path, list) {
    const all = { ...ide.settings.get(BPS, {}) };
    const conds = { ...ide.settings.get(CONDITIONS, {}) };
    for (const obj of [all, conds]) for (const k of Object.keys(obj)) if (samePath(k, path)) delete obj[k];
    if (list.length) all[path] = list.map((b) => b.node);
    const c = Object.fromEntries(list.filter((b) => b.condition).map((b) => [b.node, b.condition]));
    if (Object.keys(c).length) conds[path] = c;
    ide.settings.set(BPS, all);
    ide.settings.set(CONDITIONS, conds);
    breakpointsChanged(path);
  }
  // Only steps have a line of their own: pure nodes are inlined into the step that uses them, and Start and Define
  // Function are headers.
  function breakable(graph, id) {
    const node = graph?.nodes.find((n) => n.id === id);
    return !!node && !!VS.nodeType(node.type) && VS.pinsOf(node, graph).execIn;
  }
  function toggleBreakpoints(path, graph, ids) {
    const ok = ids.filter((id) => breakable(graph, id));
    if (!ok.length) return false;
    const list = breakpoints(path);
    const has = (id) => list.some((b) => b.node === id);
    // Several selected steps: all get one unless all have one.
    const next = ok.every(has) ? list.filter((b) => !ok.includes(b.node)) : [...list, ...ok.filter((id) => !has(id)).map((node) => ({ node, condition: '' }))];
    store(path, next);
    return true;
  }
  async function editCondition(path, id) {
    const list = breakpoints(path);
    const bp = list.find((b) => b.node === id);
    const value = await ide.ui.prompt(tr('Breakpoint condition (a Python expression; empty: always suspend)'), bp?.condition || '');
    if (value == null) return;
    const condition = value.trim();
    store(path, bp ? list.map((b) => (b === bp ? { ...b, condition } : b)) : [...list, { node: id, condition }]);
  }
  function breakpointsChanged(path) {
    for (const v of views) if (samePath(v.path, path)) show(v);
    if (session && samePath(session.path, path)) ide.debugger?.sendBreakpoints(session.file);
  }

  // ---------- the debugged code ----------
  // {path, file, graph, result}: the .pyflow, the generated file debugpy runs, the graph it came from and its compile
  // result (code, map, nodeLines, pinExpr). Lines, nodes and pins of the running program map through this, never
  // through the graph being edited meanwhile.
  let session = null;
  let registered = false;
  const nodeLabel = (graph, id) => { const n = graph.nodes.find((x) => x.id === id); return n ? `${VS.titleOf(n)} (${id})` : id; };
  const source = {
    owns: (p) => !!session && samePath(p, session.file),
    breakpoints: () => breakpoints(session.path).flatMap((b) => {
      const line = session.result.nodeLines?.[b.node]?.[0];
      return line ? [{ line, ...(b.condition ? { condition: b.condition } : {}) }] : [];
    }),
    label: (p, line) => {
      const id = session.result.map[line];
      return id ? `${basename(session.path)}: ${nodeLabel(session.graph, id)}` : basename(session.path);
    },
    // A step's output is the local `<pin>_<node id>` (index_n3); Set Variable names and Python Code outputs are the
    // user's own names and stay as they are. Every such step has one data output, so the node names it.
    variableLabel: (p, name) => {
      const id = Object.keys(session.result.pinExpr || {}).find((n) => Object.entries(session.result.pinExpr[n]).some(([pin, code]) => code === name && code === `${pin}_${n}`));
      return id ? nodeLabel(session.graph, id) : null;
    },
  };
  VS.debugSession = (s) => {
    session = s;
    paused = null;
    if (!registered && ide.debugger?.registerGeneratedSource) { ide.debugger.registerGeneratedSource(source); registered = true; }
  };

  // ---------- paused here ----------
  let paused = null; // {path, node, top}
  // The node of a frame in the generated file, or null.
  const frameNode = (f) => (session && f && samePath(f.path, session.file) ? session.result.map[f.line] || null : null);
  // An uncaught exception reads like the last line of its traceback, as a failed run marks it.
  const exceptionText = ({ text, description }) => (text && description ? `${text}: ${description}` : text || description || '');
  async function onDebugContext() {
    const st = ide.debugger?.stopped?.();
    const frame = st?.frames[st.index];
    const node = frameNode(frame);
    const next = node ? { path: session.path, node, top: st.index === 0 } : null;
    if (st?.reason === 'exception') {
      const at = st.frames.map(frameNode).find(Boolean);
      if (at) for (const v of views) if (samePath(v.path, session.path)) v.view.markRuntimeError(at, exceptionText(st));
    }
    const moved = next?.node !== paused?.node || next?.top !== paused?.top;
    paused = next;
    if (next && moved) await revealPaused(next);
    for (const v of views) show(v);
  }
  // Brings the script's tab forward (it may be behind the .py file a Step Into opened) with the node in view.
  async function revealPaused(at) {
    const tab = ide.groups().flatMap((g) => g.tabs).find((t) => t.visualScript && samePath(t.path, at.path));
    const shown = await ide.openFile(at.path, { focus: false, ...(tab ? { group: tab.group } : {}) });
    const view = shown?.visualScript;
    if (view && paused === at) (view.revealNode || view.centerOn)(at.node);
  }

  // ---------- values while paused ----------
  // Pure nodes that only compute: their expression can be evaluated again without side effects. Python Expression is
  // not here (its code could do anything); outputs of steps are locals and always readable.
  const SAFE = new Set(['var.get', 'value.number', 'value.text', 'value.bool', 'value.none', 'value.list', 'math.binary', 'math.compare',
    'math.and', 'math.or', 'math.not', 'math.negate', 'text.join', 'text.format', 'convert.str', 'convert.int', 'convert.float',
    'list.len', 'list.get']);
  function sideEffectFree(graph, id, seen = new Set()) {
    if (seen.has(id)) return true;
    seen.add(id);
    const node = graph.nodes.find((n) => n.id === id);
    const def = node && VS.nodeType(node.type);
    if (!def) return false;
    if (!def.compile?.expr) return true;
    if (!SAFE.has(node.type)) return false;
    return graph.links.filter((l) => l.to.node === id).every((l) => sideEffectFree(graph, l.from.node, seen));
  }
  const lastLine = (text) => String(text).trim().split(/\r?\n/).pop();
  // ref: {node, pin} of a data output, {node, pin, side: 'in'} of a data input (its wire's value) or {link} (a wire of
  // the edited graph). Resolves {text, note} (note: text says why there is no value) or null when there is nothing to
  // show (not paused in this script, an exec pin, a node added after the debugging started).
  async function valueOf(path, ref) {
    if (!session || !samePath(session.path, path) || !ide.debugger?.isSuspended()) return null;
    const g = session.graph;
    let from = ref.link ? ref.link.from : ref;
    if (ref.side === 'in') from = g.links.find((l) => l.to.node === ref.node && l.to.pin === ref.pin)?.from;
    const expr = from && session.result.pinExpr?.[from.node]?.[from.pin];
    if (!expr) return null;
    const note = (text) => ({ text, note: true });
    if (!sideEffectFree(g, from.node)) return note(tr('(not evaluated: it would run the code again)'));
    const r = await ide.debugger.evaluate(expr, 'hover');
    if (r.error) return note(/\b(NameError|UnboundLocalError)\b/.test(r.error) ? tr('(no value yet)') : lastLine(r.error));
    return { text: r.value, note: false };
  }

  // ---------- the canvas ----------
  function show(v) {
    const graph = v.view.graph();
    const list = breakpoints(v.path).filter((b) => breakable(graph, b.node));
    v.view.setDebugState?.({
      breakpoints: list,
      paused: paused && samePath(paused.path, v.path) ? { node: paused.node, top: paused.top } : null,
    });
    v.view.host.dataset.breakpoints = list.map((b) => b.node).join(',');
    v.view.host.dataset.paused = paused && samePath(paused.path, v.path) ? paused.node : '';
  }
  const isField = (t) => !!t?.closest?.('input, textarea, select, [contenteditable="true"]');

  // view: the object VS.mountEditor returned for the .pyflow at path. Returns a disposer.
  VS.attachDebug = (view, path) => {
    const v = { view, path };
    views.add(v);
    const toggleSelected = () => toggleBreakpoints(path, view.graph(), view.selection());
    // F9 (Blueprint) and Ctrl+F8 (the IDE's Toggle Line Breakpoint) on the canvas. While the program is suspended F9 is
    // Resume Program everywhere: the IDE's keymap takes it before the canvas sees it.
    const onKey = (e) => {
      if (isField(e.target) || e.altKey || e.shiftKey || e.metaKey) return;
      const f9 = e.key === 'F9' && !e.ctrlKey;
      const ctrlF8 = e.key === 'F8' && e.ctrlKey;
      if (!f9 && !ctrlF8) return;
      if (!toggleSelected()) return;
      e.preventDefault();
      e.stopPropagation();
    };
    view.host.addEventListener('keydown', onKey);
    const offChange = view.onChange((graph) => {
      // Breakpoints of deleted nodes go (a new node may get a deleted node's id).
      if (!graph) return;
      const list = breakpoints(path);
      const kept = list.filter((b) => graph.nodes.some((n) => n.id === b.node));
      if (kept.length !== list.length) store(path, kept);
      else show(v);
    });
    view.onBreakpointClick?.((id) => toggleBreakpoints(path, view.graph(), [id]));
    view.addNodeMenu?.((id) => {
      if (!breakable(view.graph(), id)) return [];
      const bp = breakpoints(path).find((b) => b.node === id);
      return [
        { label: bp ? tr('Remove Breakpoint') : tr('Add Breakpoint'), hint: 'F9', run: () => toggleBreakpoints(path, view.graph(), [id]) },
        { label: tr('Edit Condition…'), run: () => editCondition(path, id) },
      ];
    });
    view.setValueProvider?.((ref) => valueOf(path, ref));
    show(v);
    return () => { views.delete(v); view.host.removeEventListener('keydown', onKey); offChange(); };
  };

  ide.on('debugContextChanged', () => { onDebugContext().catch((err) => console.error(err)); });
  // Breakpoints follow a renamed or moved script (or folder) and go with a deleted one.
  ide.on('filesChanged', ({ renamed, deleted } = {}) => {
    const stored = () => Object.keys(ide.settings.get(BPS, {}) || {});
    for (const [from, to] of renamed || []) {
      for (const p of stored()) {
        if (!ide.util.isUnder(p, from)) continue;
        const list = breakpoints(p);
        store(p, []);
        store(to + p.slice(from.length), list);
      }
    }
    for (const d of deleted || []) for (const p of stored()) if (ide.util.isUnder(p, d)) store(p, []);
  });

  // For tests and the code view: the breakpoints of a script, the paused node, a pin's value.
  VS.debug = { breakpoints, toggleBreakpoints, editCondition, valueOf, paused: () => paused, session: () => session };
})(window);
