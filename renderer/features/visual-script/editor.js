// The *.pyflow tab: a canvas of HTML nodes over an SVG layer of wires. The file is the only state that matters:
// every user operation becomes one edit of the document (so dirty state, saving, Local History, crash recovery,
// undo/redo and Open as Text come from the core), and any change of the document (undo, a text edit in another tab,
// a reload from disk) is parsed and drawn again. Pan, zoom and the selection are view state and never touch the file.
(function (root) {
  const VS = root.PyideVisualScript || (root.PyideVisualScript = {});
  const tr = (text, vars) => VS.tr(text, vars);

  const GRID = 16;
  const MIN_SCALE = 0.25;
  const MAX_SCALE = 2;
  const DRAG_SLOP = 4;
  const SVG_NS = 'http://www.w3.org/2000/svg';
  const CLIP_TYPE = 'application/x-pyide-pyflow';
  const VIEW_KEY = 'visualScript.view';
  const PY_KEYWORDS = new Set(('False None True and as assert async await break class continue def del elif else except finally for from '
    + 'global if import in is lambda nonlocal not or pass raise return try while with yield').split(' '));
  const isIdentifier = (s) => /^[\p{L}_][\p{L}\p{N}_]*$/u.test(s) && !PY_KEYWORDS.has(s);
  const slug = (s) => String(s || 'other').toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '');

  const h = (tag, cls, text) => {
    const n = document.createElement(tag);
    if (cls) n.className = cls;
    if (text !== undefined && text !== null) n.textContent = text;
    return n;
  };
  const svg = (tag, attrs = {}) => {
    const n = document.createElementNS(SVG_NS, tag);
    for (const [k, v] of Object.entries(attrs)) n.setAttribute(k, v);
    return n;
  };
  const sameEnd = (a, b) => a.node === b.node && a.pin === b.pin;
  const sameLink = (a, b) => sameEnd(a.from, b.from) && sameEnd(a.to, b.to);
  const isField = (t) => !!t?.closest?.('input, textarea, select, [contenteditable="true"]');

  // ---------- node type helpers ----------
  const defOf = (node) => VS.nodeType(node.type);
  const optionsOf = (prop) => (prop.options || []).map((o) => (o && typeof o === 'object' ? { value: o.value, label: o.label ?? String(o.value) } : { value: o, label: String(o) }));
  function titleOf(node) {
    if (!defOf(node)) return node.type;
    try { return VS.titleOf(node); } catch { return node.type; }
  }
  const subtitleOf = (node) => { try { return VS.subtitleOf ? VS.subtitleOf(node) : ''; } catch { return ''; } };
  const englishTitle = (def) => (typeof def.title === 'string' ? def.title : '');
  const EMPTY_PINS = { execIn: false, execOut: [], inputs: [], outputs: [] };
  // Only a node type's own pins have English labels to translate. Pins it makes from the node (Format Text fields,
  // function parameters, numbered items) are named by the user or already translated, and are shown as they are.
  const ownPin = (node, p) => { const def = defOf(node); return !!def && [def.inputs, def.outputs, def.exec?.out].some((list) => list?.includes(p)); };
  const pinLabel = (node, p) => (!p.label ? '' : ownPin(node, p) ? tr(p.label) : p.label);
  const labelEl = (node, p) => { const s = h('span', 'vs-label', pinLabel(node, p)); if (!ownPin(node, p)) s.setAttribute('data-user-text', ''); return s; };
  function pinsOf(node, graph) {
    if (!defOf(node)) return EMPTY_PINS;
    try { return VS.pinsOf(node, graph) || EMPTY_PINS; } catch (err) { console.error(err); return EMPTY_PINS; }
  }
  let datalistSeq = 0;
  // An "any" input's field: 42 is the number 42, other text is text, and "42" (in quotes) is the text 42.
  const NUMBER_RE = /^-?(\d+\.?\d*|\.\d+)([eE][+-]?\d+)?$/;
  const anyValue = (text) => {
    const t = text.trim();
    if (NUMBER_RE.test(t) && Number.isFinite(Number(t))) return Number(t);
    const q = /^"(.*)"$/s.exec(t);
    return q ? q[1] : text;
  };
  const anyText = (v) => {
    if (v === undefined || v === null) return '';
    if (typeof v === 'number') return String(v);
    const s = String(v);
    return typeof anyValue(s) === 'number' || /^".*"$/s.test(s.trim()) ? `"${s}"` : s;
  };
  const typeName = (type) => (VS.typeLabel ? VS.typeLabel(type) : type);

  function mountEditor(host, { doc, path, tab }) {
    const monaco = root.ide?.monaco || root.monaco;
    const model = doc.model;
    const fileName = path.split(/[\\/]/).pop();
    host.classList.add('vs-host');
    host.tabIndex = -1;

    // ---------- DOM ----------
    const bar = h('div', 'vs-toolbar');
    const slot = h('div', 'vs-toolbar-slot');
    const button = (cls, label, title, run) => {
      const b = h('button', `vs-btn ${cls}`, label);
      b.type = 'button';
      b.title = title;
      b.addEventListener('click', () => { run(); canvas.focus(); });
      return b;
    };
    const zoomLabel = button('vs-zoom-label', '100%', tr('Reset Zoom (Ctrl+0)'), () => zoomTo(1));
    bar.append(
      button('vs-add', tr('Add Node'), tr('Add a node (Tab or double-click the canvas)'), () => openPalette(centerPoint())),
      h('span', 'vs-sep'),
      button('vs-fit', tr('Fit'), tr('Fit all nodes in the view'), () => fit()),
      button('vs-zoom-out', '−', tr('Zoom Out'), () => zoomBy(1 / 1.2)),
      zoomLabel,
      button('vs-zoom-in', '+', tr('Zoom In'), () => zoomBy(1.2)),
      h('span', 'vs-sep'),
      slot,
    );
    const banner = h('div', 'vs-banner hidden');
    const bannerText = h('span', 'vs-banner-text');
    bannerText.setAttribute('data-user-text', '');
    const bannerBtn = h('button', 'vs-btn vs-banner-btn', tr('Open as Text'));
    bannerBtn.type = 'button';
    bannerBtn.addEventListener('click', () => root.ide.openFile(path, { asText: true }));
    banner.append(h('span', 'vs-banner-icon', '⚠'), bannerText, bannerBtn);

    const main = h('div', 'vs-main');
    const canvas = h('div', 'vs-canvas');
    canvas.tabIndex = 0;
    const layer = h('div', 'vs-layer');
    const wires = svg('svg', { class: 'vs-wires', width: '200000', height: '200000', viewBox: '-100000 -100000 200000 200000' });
    const wireGroup = svg('g', { class: 'vs-wire-group' });
    const tempWire = svg('path', { class: 'vs-temp hidden' });
    wires.append(wireGroup, tempWire);
    const nodeLayer = h('div', 'vs-nodes');
    layer.append(wires, nodeLayer);
    const box = h('div', 'vs-box hidden');
    const grid = h('div', 'vs-grid');
    canvas.append(grid, layer, box);
    const side = h('div', 'vs-side hidden');
    main.append(canvas, side);

    const status = h('div', 'vs-status');
    const problems = h('button', 'vs-problems', tr('No problems'));
    problems.type = 'button';
    problems.addEventListener('click', () => { const e = errors.find((x) => x.node && views.has(x.node)); if (e) { select([e.node]); centerOn(e.node); } canvas.focus(); });
    const hint = h('span', 'vs-hint');
    const counts = h('span', 'vs-counts');
    status.append(problems, hint, h('span', 'vs-spacer'), counts);
    host.append(bar, banner, main, status);

    // ---------- state ----------
    let graph = null;
    let lastText = null; // the document text (LF) that `graph` was read from or written as
    let invalid = null; // the parse error while the document is not a valid script
    let disposed = false;
    const views = new Map(); // node id -> {el, sig, node, w, h, pins: Map('in:pin'|'out:pin' -> {x, y, el}), measured}
    let selection = new Set();
    let errors = [];
    let runtime = null; // {node, message}
    const listeners = new Set();
    const selectListeners = new Set();
    const savedViews = root.ide.settings.get(VIEW_KEY, {}) || {};
    const viewKey = path.toLowerCase();
    const saved = savedViews[viewKey]?.s > 0 ? savedViews[viewKey] : null;
    let view = saved ? { s: saved.s, tx: saved.tx, ty: saved.ty } : { s: 1, tx: 0, ty: 0 };
    let needsFit = !saved; // a file opened for the first time is fitted once the canvas has a size
    const disposers = [];

    // ---------- view (pan and zoom) ----------
    let viewFrame = 0;
    let drawnScale = 1; // the scale the layer is drawn at now; setView applies a new one in the next frame
    function applyView() {
      viewFrame = 0;
      drawnScale = view.s;
      layer.style.transform = `translate(${view.tx}px, ${view.ty}px) scale(${view.s})`;
      // The grid is a layer one major cell larger than the canvas, shifted by the pan modulo that cell, so panning
      // moves it on the compositor instead of painting the canvas background again.
      const g = GRID * view.s;
      const major = g * 8;
      if (grid._g !== g) {
        grid._g = g;
        grid.style.backgroundSize = `${g}px ${g}px, ${major}px ${major}px`;
        grid.style.inset = `${-major}px`;
      }
      const mod = (v) => ((v % major) + major) % major;
      grid.style.transform = `translate(${mod(view.tx)}px, ${mod(view.ty)}px)`;
      zoomLabel.textContent = `${Math.round(view.s * 100)}%`;
      host.dataset.zoom = view.s.toFixed(3);
    }
    let saveTimer = 0;
    function setView(v) {
      view = v;
      if (!viewFrame) viewFrame = requestAnimationFrame(applyView);
      clearTimeout(saveTimer);
      saveTimer = setTimeout(saveView, 600);
    }
    function saveView() {
      saveTimer = 0;
      const all = { ...(root.ide.settings.get(VIEW_KEY, {}) || {}) };
      delete all[viewKey];
      all[viewKey] = { s: +view.s.toFixed(4), tx: Math.round(view.tx), ty: Math.round(view.ty) };
      const keys = Object.keys(all);
      for (const k of keys.slice(0, Math.max(0, keys.length - 50))) delete all[k];
      root.ide.settings.set(VIEW_KEY, all);
    }
    const clampScale = (s) => Math.max(MIN_SCALE, Math.min(MAX_SCALE, s));
    const canvasRect = () => canvas.getBoundingClientRect();
    const centerPoint = () => { const r = canvasRect(); return { clientX: r.left + r.width / 2, clientY: r.top + r.height / 2 }; };
    function zoomAt(s, cx, cy) {
      const ns = clampScale(s);
      const { s: os, tx, ty } = view;
      setView({ s: ns, tx: cx - ((cx - tx) / os) * ns, ty: cy - ((cy - ty) / os) * ns });
    }
    const zoomBy = (f) => { const r = canvasRect(); zoomAt(view.s * f, r.width / 2, r.height / 2); };
    const zoomTo = (s) => { const r = canvasRect(); zoomAt(s, r.width / 2, r.height / 2); };
    const toCanvas = (clientX, clientY) => {
      const r = canvasRect();
      return { x: (clientX - r.left - view.tx) / view.s, y: (clientY - r.top - view.ty) / view.s };
    };
    function bounds(ids) {
      if (!graph) return null;
      let x0 = Infinity; let y0 = Infinity; let x1 = -Infinity; let y1 = -Infinity;
      for (const n of graph.nodes) {
        if (ids && !ids.has(n.id)) continue;
        const v = views.get(n.id);
        x0 = Math.min(x0, n.x); y0 = Math.min(y0, n.y);
        x1 = Math.max(x1, n.x + (v?.w || 160)); y1 = Math.max(y1, n.y + (v?.h || 60));
      }
      return x0 === Infinity ? null : { x0, y0, x1, y1 };
    }
    function fit() {
      const r = canvasRect();
      const b = bounds();
      if (!r.width || !r.height) return;
      if (!b) { setView({ s: 1, tx: r.width / 2, ty: r.height / 2 }); return; }
      const pad = 48;
      // A graph that fits at 100% with a slim margin stays at 100%: shrinking it only for the margin makes text smaller.
      const fitsAt100 = b.x1 - b.x0 <= r.width - 32 && b.y1 - b.y0 <= r.height - 32;
      const s = fitsAt100 ? 1 : clampScale(Math.min(1, (r.width - 2 * pad) / (b.x1 - b.x0), (r.height - 2 * pad) / (b.y1 - b.y0)));
      setView({ s, tx: (r.width - (b.x1 - b.x0) * s) / 2 - b.x0 * s, ty: (r.height - (b.y1 - b.y0) * s) / 2 - b.y0 * s });
    }
    function centerOn(id) {
      const n = graph?.nodes.find((x) => x.id === id);
      if (!n) return;
      const v = views.get(id);
      const r = canvasRect();
      setView({ s: view.s, tx: r.width / 2 - (n.x + (v?.w || 160) / 2) * view.s, ty: r.height / 2 - (n.y + (v?.h || 60) / 2) * view.s });
    }

    // ---------- document sync ----------
    const lfText = () => model.getValue(monaco.editor.EndOfLinePreference.LF);
    function positionAt(text, offset) {
      let line = 1;
      let start = 0;
      for (let i = text.indexOf('\n'); i !== -1 && i < offset; i = text.indexOf('\n', i + 1)) { line++; start = i + 1; }
      return { lineNumber: line, column: offset - start + 1 };
    }
    let applying = false;
    // One user operation = one undo step: the smallest edit that turns the document into `text`, between stack marks.
    function writeText(text) {
      const old = lfText();
      if (old === text) return;
      let a = 0;
      const max = Math.min(old.length, text.length);
      while (a < max && old.charCodeAt(a) === text.charCodeAt(a)) a++;
      let b = 0;
      while (b < max - a && old.charCodeAt(old.length - 1 - b) === text.charCodeAt(text.length - 1 - b)) b++;
      const s = positionAt(old, a);
      const e = positionAt(old, old.length - b);
      applying = true;
      try {
        model.pushStackElement();
        model.pushEditOperations([], [{ range: new monaco.Range(s.lineNumber, s.column, e.lineNumber, e.column), text: text.slice(a, text.length - b) }], () => null);
        model.pushStackElement();
      } finally { applying = false; }
      root.ide.renderTabs?.();
    }
    function commit(next, { select: ids } = {}) {
      if (!next || next === graph || invalid) return false;
      const text = VS.serialize(next);
      graph = next;
      if (text !== lastText) {
        lastText = text;
        writeText(text);
      }
      runtime = null;
      if (ids) selection = new Set(ids);
      render();
      changed();
      return true;
    }
    function load() {
      const text = lfText();
      if (text === lastText && !invalid) return;
      let parsed;
      try { parsed = VS.parse(text); } catch (err) {
        invalid = err;
        lastText = text;
        showInvalid();
        return;
      }
      invalid = null;
      lastText = text;
      graph = parsed;
      for (const id of [...selection]) if (!graph.nodes.some((n) => n.id === id)) selection.delete(id);
      hideInvalid();
      render();
      changed();
      if (needsFit && canvas.clientWidth) { needsFit = false; fit(); }
    }
    // A text edit elsewhere is invalid JSON for a moment while the user types: the banner waits for a pause.
    let bannerTimer = 0;
    function showInvalid() {
      host.dataset.invalid = 'true';
      canvas.classList.add('vs-inert');
      clearTimeout(bannerTimer);
      bannerTimer = setTimeout(() => {
        if (!invalid) return;
        bannerText.textContent = tr('This visual script cannot be shown: {error}', { error: invalid.message });
        banner.classList.remove('hidden');
      }, graph ? 300 : 0);
    }
    function hideInvalid() {
      clearTimeout(bannerTimer);
      delete host.dataset.invalid;
      canvas.classList.remove('vs-inert');
      banner.classList.add('hidden');
    }
    disposers.push(model.onDidChangeContent(() => { if (!applying && !disposed) load(); }));

    // ---------- live errors ----------
    let compileTimer = 0;
    function changed() {
      clearTimeout(compileTimer);
      compileTimer = setTimeout(compileNow, 300);
      host.dataset.version = String((Number(host.dataset.version) || 0) + 1);
      for (const fn of listeners) { try { fn(graph); } catch (err) { console.error(err); } }
    }
    function compileNow() {
      compileTimer = 0;
      if (disposed || !graph || !VS.compile) return;
      let r;
      try { r = VS.compile(graph, { fileName }); } catch (err) { console.error(err); return; }
      errors = r?.errors || [];
      applyErrors();
    }
    function applyErrors() {
      const byNode = new Map();
      for (const e of errors) {
        if (!e.node) continue;
        if (!byNode.has(e.node)) byNode.set(e.node, []);
        byNode.get(e.node).push(e);
      }
      for (const [id, v] of views) {
        const list = byNode.get(id) || [];
        const bad = list.filter((e) => !e.warning);
        v.el.classList.toggle('vs-err', bad.length > 0);
        v.el.classList.toggle('vs-warn', !bad.length && list.length > 0);
        for (const p of v.el.querySelectorAll('.vs-pin-err')) p.classList.remove('vs-pin-err');
        for (const e of bad) if (e.pin) v.pins.get(`in:${e.pin}`)?.el.classList.add('vs-pin-err');
        let badge = v.el.querySelector(':scope > .vs-badge');
        const rt = runtime?.node === id ? runtime : null;
        if (!list.length && !rt) { badge?.remove(); v.el.querySelector(':scope > .vs-runtime')?.remove(); continue; }
        if (list.length) {
          if (!badge) { badge = h('span', 'vs-badge', '!'); v.el.appendChild(badge); }
          badge.classList.toggle('vs-badge-warn', !bad.length);
          badge.title = list.map((e) => e.message).join('\n');
        } else badge?.remove();
        let msg = v.el.querySelector(':scope > .vs-runtime');
        if (rt) {
          if (!msg) { msg = h('div', 'vs-runtime'); msg.setAttribute('data-user-text', ''); v.el.appendChild(msg); }
          msg.textContent = rt.message;
          msg.title = rt.message;
        } else msg?.remove();
      }
      for (const v of views.values()) v.el.classList.toggle('vs-runtime-err', runtime?.node === v.node.id);
      const nErr = errors.filter((e) => !e.warning).length;
      const nWarn = errors.length - nErr;
      const parts = [];
      if (nErr) parts.push(nErr === 1 ? tr('1 problem') : tr('{n} problems', { n: nErr }));
      if (nWarn) parts.push(nWarn === 1 ? tr('1 warning') : tr('{n} warnings', { n: nWarn }));
      problems.textContent = parts.length ? parts.join(', ') : tr('No problems');
      problems.classList.toggle('vs-has-errors', nErr > 0);
      problems.classList.toggle('vs-has-warnings', !nErr && nWarn > 0);
      problems.title = errors.map((e) => e.message).join('\n');
      host.dataset.problems = String(nErr);
    }

    // ---------- rendering ----------
    // node id -> Set of 'in:pin' / 'out:pin' with a wire, rebuilt once per render.
    let linkedPins = new Map();
    function indexLinks() {
      linkedPins = new Map();
      const add = (id, key) => { if (!linkedPins.has(id)) linkedPins.set(id, new Set()); linkedPins.get(id).add(key); };
      for (const l of graph.links) { add(l.to.node, `in:${l.to.pin}`); add(l.from.node, `out:${l.from.pin}`); }
      wireTypes = graph.links.map(wireType);
    }
    const NO_PINS = new Set();
    const connectedPins = (id) => linkedPins.get(id) || NO_PINS;
    const connectedInputs = (id) => [...connectedPins(id)].filter((k) => k.startsWith('in:')).map((k) => k.slice(3));
    function pinEl(node, sideName, pin, kind, type, label) {
      const p = h('span', `vs-pin vs-pin-${sideName} ${kind === 'exec' ? 'vs-exec' : 'vs-data'}`);
      p.dataset.node = node.id;
      p.dataset.side = sideName;
      p.dataset.pin = pin;
      p.dataset.kind = kind;
      p.style.setProperty('--vs-pin', `var(--vs-type-${kind === 'exec' ? 'exec' : type || 'any'})`);
      const what = kind === 'exec' ? tr('Run order') : typeName(type || 'any');
      p.title = label ? `${label} (${what})` : what;
      return p;
    }
    function literalField(node, pin) {
      const value = node.inputs && pin.id in node.inputs ? node.inputs[pin.id] : pin.default;
      const type = pin.type || 'any';
      if (type === 'bool') {
        const c = h('input', 'vs-field vs-check');
        c.type = 'checkbox';
        c.checked = !!value;
        c.indeterminate = value === undefined;
        c.title = pinLabel(node, pin);
        c.addEventListener('change', () => commit(VS.setInputLiteral(graph, node.id, pin.id, c.checked)));
        return c;
      }
      if (!['any', 'number', 'int', 'string'].includes(type)) return null;
      const numeric = type === 'number' || type === 'int';
      const f = h('input', `vs-field ${numeric ? 'vs-num' : 'vs-text'}`);
      f.type = 'text';
      f.spellcheck = false;
      const shown = type === 'any' ? anyText(value) : value === undefined || value === null ? '' : String(value);
      f.value = shown;
      if (!numeric) f.size = Math.max(10, Math.min(28, shown.length + 1));
      f.setAttribute('data-user-text', '');
      f.title = type === 'any'
        ? tr('Value of {name}: a number like 42, or text. Put text that looks like a number in quotes: "42".', { name: pinLabel(node, pin) || pin.id })
        : tr('Value of {name}', { name: pinLabel(node, pin) || pin.id });
      const parse = () => {
        if (type === 'any') return { ok: true, v: anyValue(f.value) };
        if (!numeric) return { ok: true, v: f.value };
        const t = f.value.trim();
        const v = Number(t);
        const ok = t !== '' && Number.isFinite(v) && (type !== 'int' || Number.isInteger(v));
        return { ok, v };
      };
      f.addEventListener('input', () => f.classList.toggle('vs-invalid', !parse().ok));
      f.addEventListener('change', () => {
        const r = parse();
        if (!r.ok) { f.value = shown; f.classList.remove('vs-invalid'); return; }
        commit(VS.setInputLiteral(graph, node.id, pin.id, r.v));
      });
      return f;
    }
    function propField(node, prop) {
      const value = VS.propOf(node, prop.id);
      const label = h('label', 'vs-prop');
      const name = h('span', 'vs-prop-name', tr(prop.label || prop.id));
      label.appendChild(name);
      const set = (v) => commit(VS.setProp(graph, node.id, prop.id, v));
      let f;
      if (prop.kind === 'select') {
        f = h('select', 'vs-field vs-select');
        for (const o of optionsOf(prop)) {
          const opt = h('option', '', o.label);
          opt.value = String(o.value);
          f.appendChild(opt);
        }
        f.value = String(value);
        f.addEventListener('change', () => { const o = optionsOf(prop).find((x) => String(x.value) === f.value); set(o ? o.value : f.value); });
      } else if (prop.kind === 'bool') {
        f = h('input', 'vs-field vs-check');
        f.type = 'checkbox';
        f.checked = !!value;
        f.addEventListener('change', () => set(f.checked));
      } else if (prop.kind === 'code') {
        f = h('textarea', 'vs-field vs-code');
        f.spellcheck = false;
        f.rows = Math.min(8, Math.max(2, String(value ?? '').split('\n').length));
        f.value = value ?? '';
        f.setAttribute('data-user-text', '');
        f.addEventListener('change', () => set(f.value));
      } else {
        f = h('input', `vs-field ${prop.kind === 'number' ? 'vs-num' : 'vs-text'}`);
        f.type = 'text';
        f.spellcheck = false;
        f.value = value === undefined || value === null ? '' : String(value);
        f.setAttribute('data-user-text', '');
        if (prop.placeholder) f.placeholder = prop.placeholder;
        if (prop.suggest === 'functions' && VS.functionNames) {
          const list = h('datalist');
          list.id = `vs-dl-${++datalistSeq}`;
          for (const name of VS.functionNames(graph)) list.appendChild(Object.assign(h('option'), { value: name }));
          f.setAttribute('list', list.id);
          label.appendChild(list);
        }
        const check = () => {
          if (prop.kind === 'number') {
            const t = f.value.trim();
            const v = Number(t);
            return t !== '' && Number.isFinite(v) && !(prop.min !== undefined && v < prop.min) && !(prop.max !== undefined && v > prop.max);
          }
          if (prop.kind === 'identifier') return isIdentifier(f.value.trim());
          return true;
        };
        const mark = () => {
          const ok = check();
          f.classList.toggle('vs-invalid', !ok);
          const range = prop.min !== undefined && prop.max !== undefined;
          f.title = ok ? '' : prop.kind === 'identifier' ? tr('Use a name made of letters, digits and _ that does not start with a digit and is not a Python keyword.')
            : range ? tr('Enter a number from {min} to {max}.', { min: prop.min, max: prop.max }) : tr('Enter a number.');
        };
        mark();
        f.addEventListener('input', mark);
        f.addEventListener('change', () => {
          if (prop.kind === 'number') {
            if (!check()) { f.value = value === undefined || value === null ? '' : String(value); mark(); return; }
            set(Number(f.value.trim()));
          } else set(prop.kind === 'identifier' ? f.value.trim() : f.value);
        });
      }
      f.title ||= tr(prop.label || prop.id);
      label.appendChild(f);
      return label;
    }
    function buildComment(node) {
      const n = h('div', 'vs-node vs-comment');
      const text = String(VS.propOf(node, 'text') ?? '');
      const body = h('div', 'vs-comment-text', text || tr('Comment'));
      body.classList.toggle('vs-placeholder', !text);
      if (text) body.setAttribute('data-user-text', '');
      n.appendChild(body);
      return n;
    }
    function buildNode(node) {
      const def = defOf(node);
      const n = def?.type === 'ui.comment' ? buildComment(node) : h('div', 'vs-node');
      n.dataset.id = node.id;
      n.dataset.type = node.type;
      const cat = slug(def?.category);
      n.style.setProperty('--vs-cat', `var(--vs-cat-${cat}, var(--vs-cat-other))`);
      if (def?.type === 'ui.comment') return n;
      if (!def) n.classList.add('vs-unknown');
      const pins = pinsOf(node, graph);
      const linked = new Set(connectedInputs(node.id));
      const head = h('div', 'vs-head');
      head.title = def ? tr(def.description || '') : tr('Unknown node type {type}', { type: node.type });
      if (pins.execIn) head.appendChild(pinEl(node, 'in', 'in', 'exec', 'exec', tr('In')));
      const title = h('span', 'vs-title', titleOf(node));
      const sub = subtitleOf(node);
      if (sub && sub !== title.textContent) {
        const s = h('span', 'vs-subtitle', sub);
        s.setAttribute('data-user-text', '');
        title.append(' ', s);
      }
      head.appendChild(title);
      const headOut = pins.execOut.length === 1 && !pins.execOut[0].label;
      if (headOut) head.appendChild(pinEl(node, 'out', pins.execOut[0].id, 'exec', 'exec', tr('Next')));
      n.appendChild(head);

      const ins = h('div', 'vs-col vs-ins');
      for (const p of pins.inputs) {
        const row = h('div', 'vs-row');
        row.appendChild(pinEl(node, 'in', p.id, 'data', p.type, pinLabel(node, p)));
        if (p.label) row.appendChild(labelEl(node, p));
        if (!linked.has(p.id)) { const f = literalField(node, p); if (f) row.appendChild(f); }
        ins.appendChild(row);
      }
      const outs = h('div', 'vs-col vs-outs');
      if (!headOut) {
        for (const p of pins.execOut) {
          const row = h('div', 'vs-row');
          row.append(labelEl(node, p), pinEl(node, 'out', p.id, 'exec', 'exec', pinLabel(node, p)));
          outs.appendChild(row);
        }
      }
      for (const p of pins.outputs) {
        const row = h('div', 'vs-row');
        row.append(labelEl(node, p), pinEl(node, 'out', p.id, 'data', p.type, pinLabel(node, p)));
        outs.appendChild(row);
      }
      if (ins.childElementCount || outs.childElementCount) {
        const rows = h('div', 'vs-rows');
        rows.append(ins, outs);
        n.appendChild(rows);
      }
      const props = (def?.props || []).filter((p) => !p.hidden);
      if (props.length) {
        const box = h('div', 'vs-props');
        for (const p of props) box.appendChild(propField(node, p));
        n.appendChild(box);
      }
      return n;
    }
    const signature = (node) => JSON.stringify([node.type, node.props, node.inputs, connectedInputs(node.id).sort(),
      defOf(node)?.pins ? pinsOf(node, graph) : 0, defOf(node)?.props?.some((p) => p.suggest === 'functions') && VS.functionNames ? VS.functionNames(graph) : 0]);

    function measure(v) {
      const s = drawnScale;
      const r = v.el.getBoundingClientRect();
      if (!r.width) return false;
      v.w = r.width / s;
      v.h = r.height / s;
      v.pins = new Map();
      for (const p of v.el.querySelectorAll('.vs-pin')) {
        const q = p.getBoundingClientRect();
        v.pins.set(`${p.dataset.side}:${p.dataset.pin}`, { x: (q.left + q.width / 2 - r.left) / s, y: (q.top + q.height / 2 - r.top) / s, el: p });
      }
      v.measured = true;
      return true;
    }
    function render() {
      if (!graph) return;
      indexLinks();
      const seen = new Set();
      const fresh = [];
      for (const node of graph.nodes) {
        seen.add(node.id);
        const sig = signature(node);
        let v = views.get(node.id);
        if (!v || v.sig !== sig) {
          const el = buildNode(node);
          if (v) v.el.replaceWith(el); else nodeLayer.appendChild(el);
          v = { el, sig, node, w: v?.w || 0, h: v?.h || 0, pins: v?.pins || new Map(), measured: false };
          views.set(node.id, v);
          fresh.push(v);
        }
        v.node = node;
        v.el.style.left = `${node.x}px`;
        v.el.style.top = `${node.y}px`;
        if (v.el.style.transform) v.el.style.transform = '';
        const conn = connectedPins(node.id);
        for (const p of v.el.querySelectorAll('.vs-pin')) p.classList.toggle('vs-linked', conn.has(`${p.dataset.side}:${p.dataset.pin}`));
      }
      for (const [id, v] of views) if (!seen.has(id)) { v.el.remove(); views.delete(id); }
      for (const v of fresh) measure(v);
      drawWires();
      applySelection();
      applyErrors();
      counts.textContent = graph.nodes.length === 1 ? tr('1 node') : tr('{n} nodes', { n: graph.nodes.length });
      host.dataset.nodes = String(graph.nodes.length);
      host.dataset.links = String(graph.links.length);
    }
    // A tab mounted while hidden has no layout: measure once it has a size.
    function remeasure() {
      let any = false;
      for (const v of views.values()) if (!v.measured) any = measure(v) || any;
      if (any) drawWires();
    }

    // ---------- wires ----------
    const curve = (x1, y1, x2, y2) => {
      const dx = Math.max(36, Math.abs(x2 - x1) * 0.5);
      return `M${x1.toFixed(1)},${y1.toFixed(1)} C${(x1 + dx).toFixed(1)},${y1.toFixed(1)} ${(x2 - dx).toFixed(1)},${y2.toFixed(1)} ${x2.toFixed(1)},${y2.toFixed(1)}`;
    };
    function pinPos(end, sideName, offsets) {
      const v = views.get(end.node);
      const p = v?.pins.get(`${sideName}:${end.pin}`);
      if (!p) return null;
      const o = offsets?.get(end.node);
      return { x: v.node.x + p.x + (o?.dx || 0), y: v.node.y + p.y + (o?.dy || 0) };
    }
    let wireTypes = [];
    function wireType(l) {
      const a = VS.findPin ? VS.findPin(graph, l.from) : null;
      if (!a) return 'any';
      if (a.kind === 'exec') return 'exec';
      if (a.type !== 'any') return a.type;
      return VS.findPin(graph, l.to)?.type || 'any';
    }
    // offsets: node id -> {dx, dy} while nodes are being dragged, so the wires follow without touching the file.
    function drawWires(offsets) {
      let markup = '';
      const tip = escapeXml(tr('Alt+click to delete this wire'));
      graph.links.forEach((l, i) => {
        const a = pinPos(l.from, 'out', offsets);
        const b = pinPos(l.to, 'in', offsets);
        if (!a || !b) return;
        const t = wireTypes[i] || 'any';
        const d = curve(a.x, a.y, b.x, b.y);
        markup += `<path class="vs-wire${t === 'exec' ? ' vs-wire-exec' : ''}" style="stroke:var(--vs-type-${t})" d="${d}"/>`
          + `<path class="vs-wire-hit" data-link="${i}" d="${d}"><title>${tip}</title></path>`;
      });
      wireGroup.innerHTML = markup;
    }
    const escapeXml = (s) => String(s).replace(/[&<>"]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' })[c]);

    // ---------- selection ----------
    let selectionKey = '';
    function applySelection() {
      for (const [id, v] of views) v.el.classList.toggle('vs-sel', selection.has(id));
      const key = [...selection].join(',');
      host.dataset.selected = key;
      if (key === selectionKey) return;
      selectionKey = key;
      for (const fn of selectListeners) { try { fn([...selection]); } catch (err) { console.error(err); } }
    }
    function select(ids, { add = false } = {}) {
      selection = add ? new Set([...selection, ...ids]) : new Set(ids);
      applySelection();
    }

    // ---------- operations ----------
    const selectedIds = () => graph.nodes.filter((n) => selection.has(n.id)).map((n) => n.id);
    function deleteSelected() {
      const ids = selectedIds();
      if (!ids.length) return;
      commit(VS.removeNodes(graph, ids), { select: [] });
    }
    function duplicateSelected() {
      const ids = selectedIds();
      if (!ids.length) return;
      const r = VS.duplicate(graph, ids, 2 * GRID, 2 * GRID);
      commit(r.graph, { select: r.ids });
    }
    const disconnectWhere = (test) => graph.links.filter(test).reduce((g, l) => VS.disconnect(g, l), graph);
    const disconnectAll = (id) => commit(disconnectWhere((l) => l.from.node === id || l.to.node === id));
    function clipboardPayload() {
      const ids = new Set(selectedIds());
      if (!ids.size) return null;
      const nodes = graph.nodes.filter((n) => ids.has(n.id));
      const links = graph.links.filter((l) => ids.has(l.from.node) && ids.has(l.to.node));
      return `${JSON.stringify({ format: VS.FORMAT || 1, nodes, links }, null, 2)}\n`;
    }
    let copying = null;
    const onCopy = (e) => {
      if (copying === null) return;
      e.clipboardData.setData(CLIP_TYPE, copying);
      e.clipboardData.setData('text/plain', copying);
      e.preventDefault();
      copying = null;
    };
    document.addEventListener('copy', onCopy, true);
    function copySelection() {
      const text = clipboardPayload();
      if (!text) return false;
      copying = text;
      const ok = document.execCommand('copy');
      if (copying !== null) { copying = null; if (!ok) navigator.clipboard.writeText(text).catch(() => {}); }
      return true;
    }
    function pastePayload(text, at) {
      let data;
      try { data = JSON.parse(text); } catch { return false; }
      const nodes = Array.isArray(data) ? data : data?.nodes;
      if (!Array.isArray(nodes) || !nodes.length) return false;
      const p = at || toCanvas(lastPointer.clientX, lastPointer.clientY);
      const r = VS.pasteNodes(graph, nodes, data.links || [], snap(p.x), snap(p.y));
      if (!r.ids.length) return false;
      commit(r.graph, { select: r.ids });
      return true;
    }
    // A page cannot ask for a paste event, so Ctrl+V reads the clipboard's text, which copy filled with the same JSON
    // as the application/x-pyide-pyflow type.
    async function pasteFromClipboard(at) {
      const text = await navigator.clipboard.readText().catch(() => '');
      if (!disposed) pastePayload(text, at);
    }
    const snap = (v) => Math.round(v / GRID) * GRID;

    // ---------- palette ----------
    let palette = null;
    // origin: a pin the user dragged a wire from; the palette then lists only types with a pin that fits it, and
    // the new node is wired to that pin.
    function candidateTypes(origin) {
      const defs = VS.nodeTypes().filter((d) => d.type !== 'core.start' || !graph.nodes.some((n) => n.type === 'core.start'));
      if (!origin) return defs.map((def) => ({ def }));
      const out = [];
      for (const def of defs) {
        const id = VS.nextId(graph);
        const g = VS.addNode(graph, { id, type: def.type, x: 0, y: 0 });
        const node = g.nodes.find((n) => n.id === id);
        const pins = pinsOf(node, g);
        const ends = origin.side === 'out'
          ? [...(pins.execIn ? ['in'] : []), ...pins.inputs.map((p) => p.id)]
          : [...pins.execOut.map((p) => p.id), ...pins.outputs.map((p) => p.id)];
        const from = { node: origin.node, pin: origin.pin };
        const pin = ends.find((e) => VS.connect(g, from, { node: id, pin: e }) !== g);
        if (pin) out.push({ def, pin });
      }
      return out;
    }
    function openPalette(point, origin = null) {
      closePalette();
      const at = toCanvas(point.clientX, point.clientY);
      const cands = candidateTypes(origin);
      const items = cands.map(({ def, pin }) => {
        const title = titleOf({ type: def.type });
        const cat = def.category || 'Other';
        const hay = [title, englishTitle(def), tr(cat), cat, def.keywords || '', tr(def.description || ''), def.description || '', def.type]
          .join(' ').toLowerCase();
        return { def, pin, title, cat, hay };
      });
      const order = VS.CATEGORIES || [];
      const catIndex = (c) => { const i = order.indexOf(c); return i === -1 ? order.length : i; };
      items.sort((a, b) => catIndex(a.cat) - catIndex(b.cat) || a.cat.localeCompare(b.cat));

      const el = h('div', 'vs-palette');
      const input = h('input', 'vs-pal-input');
      input.type = 'text';
      input.spellcheck = false;
      input.placeholder = origin ? tr('Search nodes that fit this pin') : tr('Search nodes');
      input.setAttribute('aria-label', tr('Search nodes'));
      const list = h('div', 'vs-pal-list');
      list.setAttribute('role', 'listbox');
      const empty = h('div', 'vs-pal-empty hidden', tr('No matching nodes'));
      el.append(input, list, empty);
      host.appendChild(el);
      const collapsed = new Set();
      let shown = [];
      let active = 0;
      function draw() {
        const q = input.value.trim().toLowerCase();
        const tokens = q.split(/\s+/).filter(Boolean);
        let matches = items.filter((it) => tokens.every((t) => it.hay.includes(t)));
        if (q) {
          const rank = (it) => (it.title.toLowerCase().startsWith(q) || englishTitle(it.def).toLowerCase().startsWith(q) ? 0 : 1);
          matches = matches.map((it, i) => ({ it, i })).sort((a, b) => rank(a.it) - rank(b.it) || a.i - b.i).map((x) => x.it);
        }
        list.replaceChildren();
        shown = [];
        let lastCat = null;
        for (const it of matches) {
          if (!q && it.cat !== lastCat) {
            lastCat = it.cat;
            const head = h('div', 'vs-pal-cat');
            head.dataset.cat = it.cat;
            head.append(h('span', `vs-pal-arrow${collapsed.has(it.cat) ? ' vs-closed' : ''}`, '▾'), h('span', '', tr(it.cat)));
            head.style.setProperty('--vs-cat', `var(--vs-cat-${slug(it.cat)}, var(--vs-cat-other))`);
            head.addEventListener('mousedown', (e) => { e.preventDefault(); if (collapsed.has(it.cat)) collapsed.delete(it.cat); else collapsed.add(it.cat); draw(); });
            list.appendChild(head);
          }
          if (!q && collapsed.has(it.cat)) continue;
          const row = h('div', 'vs-pal-item');
          row.setAttribute('role', 'option');
          row.dataset.type = it.def.type;
          row.style.setProperty('--vs-cat', `var(--vs-cat-${slug(it.cat)}, var(--vs-cat-other))`);
          row.append(h('span', 'vs-pal-dot'), h('span', 'vs-pal-title', it.title));
          if (q) row.appendChild(h('span', 'vs-pal-hint', tr(it.cat)));
          row.title = tr(it.def.description || '');
          const index = shown.length;
          row.addEventListener('mousemove', () => { if (active !== index) { active = index; mark(); } });
          row.addEventListener('mousedown', (e) => { e.preventDefault(); pick(it); });
          list.appendChild(row);
          shown.push({ it, row });
        }
        active = Math.min(active, Math.max(0, shown.length - 1));
        empty.classList.toggle('hidden', shown.length > 0);
        mark();
      }
      function mark() {
        shown.forEach((s, i) => { s.row.classList.toggle('vs-active', i === active); s.row.setAttribute('aria-selected', String(i === active)); });
        const row = shown[active]?.row;
        if (row) {
          const top = row.offsetTop;
          if (top < list.scrollTop) list.scrollTop = top;
          else if (top + row.offsetHeight > list.scrollTop + list.clientHeight) list.scrollTop = top + row.offsetHeight - list.clientHeight;
        }
      }
      function pick(it) {
        closePalette();
        addNodeAt(it.def, at, origin, it.pin);
      }
      input.addEventListener('input', () => { active = 0; draw(); });
      input.addEventListener('keydown', (e) => {
        const step = { ArrowDown: 1, ArrowUp: -1, PageDown: 8, PageUp: -8 }[e.key];
        if (step) {
          e.preventDefault();
          if (shown.length) active = (active + step + shown.length * 8) % shown.length;
          mark();
        } else if (e.key === 'Enter') {
          e.preventDefault();
          if (shown[active]) pick(shown[active].it);
        } else if (e.key === 'Escape') {
          e.preventDefault();
          e.stopPropagation();
          closePalette();
        } else if (e.key === 'Tab') e.preventDefault();
        e.stopPropagation();
      });
      draw();
      const hr = host.getBoundingClientRect();
      const w = el.offsetWidth;
      const ht = el.offsetHeight;
      el.style.left = `${Math.max(4, Math.min(point.clientX - hr.left, hr.width - w - 4))}px`;
      el.style.top = `${Math.max(4, Math.min(point.clientY - hr.top, hr.height - ht - 4))}px`;
      const outside = (e) => { if (!el.contains(e.target)) closePalette(); };
      setTimeout(() => document.addEventListener('mousedown', outside, true));
      palette = { el, close: () => document.removeEventListener('mousedown', outside, true), origin };
      host.dataset.palette = 'open';
      input.focus();
    }
    function closePalette({ focus = true } = {}) {
      if (!palette) return;
      palette.close();
      palette.el.remove();
      palette = null;
      delete host.dataset.palette;
      if (focus && !disposed) canvas.focus();
    }
    function addNodeAt(def, at, origin, pin) {
      const id = VS.nextId(graph);
      const x = origin?.side === 'in' ? at.x - 200 : at.x;
      let g = VS.addNode(graph, { id, type: def.type, x: snap(x), y: snap(at.y - 12) });
      if (origin && pin) g = VS.connect(g, { node: origin.node, pin: origin.pin }, { node: id, pin });
      commit(g, { select: [id] });
      return id;
    }

    // ---------- context menus ----------
    function nodeMenu(e, id) {
      if (!selection.has(id)) select([id]);
      const node = graph.nodes.find((n) => n.id === id);
      const items = [
        { label: tr('Delete'), hint: 'Delete', run: deleteSelected },
        { label: tr('Duplicate'), hint: 'Ctrl+D', run: duplicateSelected },
        { label: tr('Copy'), hint: 'Ctrl+C', run: copySelection },
        { label: tr('Disconnect All'), disabled: !graph.links.some((l) => l.from.node === id || l.to.node === id), run: () => disconnectAll(id) },
      ];
      if (node?.type === 'ui.comment') items.push({ separator: true }, { label: tr('Edit Text'), run: () => editComment(id) });
      root.ide.ui.contextMenu(e.clientX, e.clientY, items);
    }
    function canvasMenu(e) {
      const point = { clientX: e.clientX, clientY: e.clientY };
      const at = toCanvas(e.clientX, e.clientY);
      root.ide.ui.contextMenu(e.clientX, e.clientY, [
        { label: tr('Add Node…'), hint: 'Tab', run: () => openPalette(point) },
        { label: tr('Paste'), hint: 'Ctrl+V', run: () => pasteFromClipboard({ x: at.x, y: at.y }) },
        { label: tr('Select All'), hint: 'Ctrl+A', run: () => select(graph.nodes.map((n) => n.id)) },
        { separator: true },
        { label: tr('Fit'), run: () => fit() },
        { label: tr('Reset Zoom'), hint: 'Ctrl+0', run: () => zoomTo(1) },
      ]);
    }
    function editComment(id) {
      const v = views.get(id);
      if (!v) return;
      const text = String(VS.propOf(v.node, 'text') ?? '');
      const area = h('textarea', 'vs-field vs-comment-edit');
      area.value = text;
      area.spellcheck = false;
      area.setAttribute('data-user-text', '');
      v.el.replaceChildren(area);
      area.focus();
      area.select();
      let done = false;
      const finish = (save) => {
        if (done) return;
        done = true;
        if (save && area.value !== text) commit(VS.setProp(graph, id, 'text', area.value));
        else { v.sig = ''; render(); }
        canvas.focus();
      };
      area.addEventListener('blur', () => finish(true));
      area.addEventListener('keydown', (e) => {
        if (e.key === 'Escape') { e.preventDefault(); e.stopPropagation(); finish(false); }
        if (e.key === 'Enter' && e.ctrlKey) { e.preventDefault(); finish(true); }
      });
    }

    // ---------- mouse ----------
    let gesture = null;
    let spaceDown = false;
    const lastPointer = { clientX: 0, clientY: 0 };
    let suppressMenu = false;

    function wireEndAt(clientX, clientY) {
      const t = document.elementFromPoint(clientX, clientY);
      const p = t?.closest?.('.vs-pin');
      return p && host.contains(p) ? { node: p.dataset.node, pin: p.dataset.pin, side: p.dataset.side, el: p } : null;
    }
    function wireVerdict(origin, target) {
      if (!target || target.side === origin.side || target.node === origin.node) return { ok: false };
      const from = origin.side === 'out' ? origin : target;
      const to = origin.side === 'out' ? target : origin;
      const f = { node: from.node, pin: from.pin };
      const t = { node: to.node, pin: to.pin };
      if (graph.links.some((l) => sameLink(l, { from: f, to: t }))) return { ok: true, from: f, to: t, same: true };
      const next = VS.connect(graph, f, t);
      return { ok: next !== graph, next, from: f, to: t, why: VS.lastError };
    }
    function drawTemp(origin, x, y, state) {
      const a = pinPos(origin, origin.side);
      if (!a) return;
      tempWire.setAttribute('d', origin.side === 'out' ? curve(a.x, a.y, x, y) : curve(x, y, a.x, a.y));
      tempWire.classList.remove('hidden');
      tempWire.classList.toggle('vs-temp-bad', state === 'bad');
      tempWire.classList.toggle('vs-temp-ok', state === 'ok');
      tempWire.style.stroke = state === 'bad' ? '' : `var(--vs-type-${origin.type})`;
    }

    canvas.addEventListener('mousedown', (e) => {
      if (palette) closePalette({ focus: false });
      if (isField(e.target)) return;
      lastPointer.clientX = e.clientX;
      lastPointer.clientY = e.clientY;
      if (invalid) return;
      canvas.focus({ preventScroll: true });
      const pinNode = e.target.closest('.vs-pin');
      const nodeEl = e.target.closest('.vs-node');
      const hit = e.target.closest('.vs-wire-hit');
      if (e.button === 1 || e.button === 2 || (e.button === 0 && spaceDown)) {
        e.preventDefault();
        gesture = { kind: e.button === 2 ? 'maybe-pan' : 'pan', x: e.clientX, y: e.clientY, tx: view.tx, ty: view.ty };
        if (gesture.kind === 'pan') canvas.classList.add('vs-panning');
        return;
      }
      if (e.button !== 0) return;
      if (e.altKey && (pinNode || hit)) {
        e.preventDefault();
        if (pinNode) {
          const end = { node: pinNode.dataset.node, pin: pinNode.dataset.pin };
          const inSide = pinNode.dataset.side === 'in';
          commit(disconnectWhere((l) => sameEnd(inSide ? l.to : l.from, end)));
        } else commit(VS.disconnect(graph, graph.links[Number(hit.dataset.link)]));
        return;
      }
      if (pinNode) {
        e.preventDefault();
        const found = VS.findPin ? VS.findPin(graph, { node: pinNode.dataset.node, pin: pinNode.dataset.pin }) : null;
        gesture = { kind: 'wire', origin: { node: pinNode.dataset.node, pin: pinNode.dataset.pin, side: pinNode.dataset.side, type: found?.kind === 'exec' ? 'exec' : found?.type || 'any' } };
        canvas.classList.add('vs-wiring');
        const p = toCanvas(e.clientX, e.clientY);
        drawTemp(gesture.origin, p.x, p.y, 'none');
        return;
      }
      if (nodeEl) {
        e.preventDefault();
        const id = nodeEl.dataset.id;
        const additive = e.shiftKey || e.ctrlKey;
        if (additive) {
          if (selection.has(id) && e.ctrlKey) { selection.delete(id); applySelection(); return; }
          select([id], { add: true });
        } else if (!selection.has(id)) select([id]);
        gesture = { kind: 'move', x: e.clientX, y: e.clientY, id, ids: selectedIds(), moved: false, collapse: !additive && selection.size > 1 };
        return;
      }
      e.preventDefault();
      gesture = { kind: 'box', x: e.clientX, y: e.clientY, add: e.shiftKey || e.ctrlKey, base: new Set(selection), moved: false };
    });

    let moveFrame = 0;
    let pendingMove = null;
    function onMove(e) {
      lastPointer.clientX = e.clientX;
      lastPointer.clientY = e.clientY;
      if (!gesture) return;
      const g = gesture;
      if (g.kind === 'maybe-pan') {
        if (Math.hypot(e.clientX - g.x, e.clientY - g.y) < DRAG_SLOP) return;
        g.kind = 'pan';
        canvas.classList.add('vs-panning');
      }
      if (g.kind === 'pan') {
        setView({ s: view.s, tx: g.tx + e.clientX - g.x, ty: g.ty + e.clientY - g.y });
        return;
      }
      pendingMove = e;
      if (!moveFrame) moveFrame = requestAnimationFrame(flushMove);
    }
    function flushMove() {
      moveFrame = 0;
      const e = pendingMove;
      const g = gesture;
      if (!e || !g) return;
      if (g.kind === 'move') {
        const dx = (e.clientX - g.x) / view.s;
        const dy = (e.clientY - g.y) / view.s;
        if (!g.moved && Math.hypot(e.clientX - g.x, e.clientY - g.y) < DRAG_SLOP) return;
        g.moved = true;
        canvas.classList.add('vs-moving');
        const lead = graph.nodes.find((n) => n.id === g.id);
        const free = e.altKey;
        const sdx = free ? Math.round(dx) : snap(lead.x + dx) - lead.x;
        const sdy = free ? Math.round(dy) : snap(lead.y + dy) - lead.y;
        g.dx = sdx;
        g.dy = sdy;
        const offsets = new Map(g.ids.map((id) => [id, { dx: sdx, dy: sdy }]));
        for (const id of g.ids) {
          const v = views.get(id);
          if (v) v.el.style.transform = `translate(${sdx}px, ${sdy}px)`;
        }
        drawWires(offsets);
      } else if (g.kind === 'box') {
        if (!g.moved && Math.hypot(e.clientX - g.x, e.clientY - g.y) < DRAG_SLOP) return;
        g.moved = true;
        const r = canvasRect();
        const x0 = Math.min(g.x, e.clientX); const y0 = Math.min(g.y, e.clientY);
        const x1 = Math.max(g.x, e.clientX); const y1 = Math.max(g.y, e.clientY);
        Object.assign(box.style, { left: `${x0 - r.left}px`, top: `${y0 - r.top}px`, width: `${x1 - x0}px`, height: `${y1 - y0}px` });
        box.classList.remove('hidden');
        const a = toCanvas(x0, y0);
        const b = toCanvas(x1, y1);
        const hit = graph.nodes.filter((n) => {
          const v = views.get(n.id);
          return n.x < b.x && n.x + (v?.w || 0) > a.x && n.y < b.y && n.y + (v?.h || 0) > a.y;
        }).map((n) => n.id);
        selection = g.add ? new Set([...g.base, ...hit]) : new Set(hit);
        applySelection();
      } else if (g.kind === 'wire') {
        const p = toCanvas(e.clientX, e.clientY);
        const target = wireEndAt(e.clientX, e.clientY);
        if (target && target.node !== g.origin.node) {
          const verdict = wireVerdict(g.origin, target);
          const tp = pinPos(target, target.side) || p;
          drawTemp(g.origin, tp.x, tp.y, verdict.ok ? 'ok' : 'bad');
          canvas.dataset.wire = verdict.ok ? 'ok' : 'bad';
          showHint(verdict.ok ? '' : verdict.why || '', { sticky: true });
        } else {
          drawTemp(g.origin, p.x, p.y, 'none');
          canvas.dataset.wire = 'none';
          showHint('');
        }
      }
    }
    function onUp(e) {
      const g = gesture;
      if (!g) return;
      if (moveFrame) { cancelAnimationFrame(moveFrame); moveFrame = 0; flushMove(); }
      gesture = null;
      pendingMove = null;
      canvas.classList.remove('vs-panning', 'vs-moving', 'vs-wiring');
      if (g.kind === 'pan') { if (e.button === 2) suppressMenu = true; return; }
      if (g.kind === 'move') {
        if (g.moved && (g.dx || g.dy)) commit(VS.moveNodes(graph, g.ids, g.dx, g.dy));
        else if (g.moved) render();
        else if (g.collapse) select([g.id]);
      } else if (g.kind === 'box') {
        box.classList.add('hidden');
        if (!g.moved && !g.add) select([]);
      } else if (g.kind === 'wire') {
        tempWire.classList.add('hidden');
        delete canvas.dataset.wire;
        showHint('');
        const target = wireEndAt(e.clientX, e.clientY);
        if (target) {
          const verdict = wireVerdict(g.origin, target);
          if (verdict.ok && !verdict.same) commit(verdict.next);
          else if (!verdict.ok && target.node !== g.origin.node) flashRefusal(verdict.why);
        } else if (!e.target.closest?.('.vs-node') && canvas.contains(e.target)) {
          openPalette({ clientX: e.clientX, clientY: e.clientY }, g.origin);
        }
      }
    }
    let hintTimer = 0;
    function showHint(message, { sticky = false } = {}) {
      clearTimeout(hintTimer);
      hint.textContent = message || '';
      hint.classList.toggle('vs-hint-bad', !!message);
      if (message && !sticky) hintTimer = setTimeout(() => { hint.textContent = ''; }, 5000);
    }
    function flashRefusal(message) {
      if (!message) return;
      host.dataset.refused = message;
      showHint(message);
    }
    window.addEventListener('mousemove', onMove);
    window.addEventListener('mouseup', onUp);
    disposers.push(() => { window.removeEventListener('mousemove', onMove); window.removeEventListener('mouseup', onUp); });

    canvas.addEventListener('contextmenu', (e) => {
      e.preventDefault();
      if (suppressMenu || invalid) { suppressMenu = false; return; }
      if (isField(e.target)) return;
      const nodeEl = e.target.closest('.vs-node');
      if (nodeEl) nodeMenu(e, nodeEl.dataset.id);
      else canvasMenu(e);
    });
    canvas.addEventListener('dblclick', (e) => {
      if (invalid || isField(e.target)) return;
      const nodeEl = e.target.closest('.vs-node');
      if (nodeEl) { if (nodeEl.classList.contains('vs-comment')) editComment(nodeEl.dataset.id); return; }
      if (e.target.closest('.vs-pin')) return;
      openPalette({ clientX: e.clientX, clientY: e.clientY });
    });
    canvas.addEventListener('wheel', (e) => {
      e.preventDefault();
      const r = canvasRect();
      zoomAt(view.s * Math.exp(-e.deltaY * 0.0015), e.clientX - r.left, e.clientY - r.top);
    }, { passive: false });
    canvas.addEventListener('mousemove', (e) => { lastPointer.clientX = e.clientX; lastPointer.clientY = e.clientY; });

    // ---------- keyboard ----------
    const pointerInCanvas = () => {
      const r = canvasRect();
      const { clientX: x, clientY: y } = lastPointer;
      return x >= r.left && x <= r.right && y >= r.top && y <= r.bottom ? { clientX: x, clientY: y } : centerPoint();
    };
    host.addEventListener('keydown', (e) => {
      if (disposed) return;
      if (isField(e.target)) {
        if (e.key === 'Escape') { e.preventDefault(); e.stopPropagation(); e.target.blur(); canvas.focus(); }
        else if (e.key === 'Enter' && e.target.tagName === 'INPUT') { e.preventDefault(); e.target.blur(); canvas.focus(); }
        return;
      }
      if (palette?.el.contains(e.target) || e.target.closest?.('button')) return;
      const ctrl = e.ctrlKey || e.metaKey;
      const k = e.key.length === 1 ? e.key.toLowerCase() : e.key;
      let run = null;
      if (ctrl && !e.altKey) {
        if (k === 'z' && !e.shiftKey) run = () => model.undo();
        else if ((k === 'y' && !e.shiftKey) || (k === 'z' && e.shiftKey)) run = () => model.redo();
        else if (invalid) return;
        else if (k === 'a') run = () => select(graph.nodes.map((n) => n.id));
        else if (k === 'd') run = duplicateSelected;
        else if (k === 'c') run = () => copySelection();
        else if (k === 'x') run = () => { if (copySelection()) deleteSelected(); };
        else if (k === 'v') run = () => pasteFromClipboard();
        else if (k === '0' || e.code === 'Digit0') run = () => zoomTo(1);
        else if (k === '=' || k === '+') run = () => zoomBy(1.2);
        else if (k === '-') run = () => zoomBy(1 / 1.2);
      } else if (!ctrl && !e.altKey && !invalid) {
        if (k === 'Delete' || k === 'Backspace') run = deleteSelected;
        else if (k === 'Tab') run = () => openPalette(pointerInCanvas());
        else if (k === 'Escape' && selection.size) run = () => select([]);
        else if (k === ' ') run = () => { spaceDown = true; canvas.classList.add('vs-space'); };
      }
      if (!run) return;
      e.preventDefault();
      e.stopPropagation();
      run();
    });
    host.addEventListener('keyup', (e) => { if (e.key === ' ') { spaceDown = false; canvas.classList.remove('vs-space'); } });
    canvas.addEventListener('blur', () => { spaceDown = false; canvas.classList.remove('vs-space'); });
    // The custom tab's host gets the focus when the tab is activated; the canvas takes the keys.
    host.addEventListener('focus', (e) => { if (e.target === host) canvas.focus({ preventScroll: true }); });

    // A field being typed in is written before the document is saved.
    disposers.push(root.ide.on('beforeSave', (t) => {
      if (t?.doc !== doc && t?.path !== path) return;
      const f = document.activeElement;
      if (f && host.contains(f) && isField(f)) f.dispatchEvent(new Event('change'));
    }));

    // ---------- startup ----------
    applyView();
    load();
    root.ide.util.observeSize(canvas, () => {
      if (disposed || !canvas.clientWidth) return;
      remeasure();
      if (needsFit && graph) { needsFit = false; fit(); }
    });

    const api = {
      host,
      canvas,
      toolbar: slot,
      side,
      path,
      dispose() {
        if (disposed) return;
        disposed = true;
        const f = document.activeElement;
        if (f && host.contains(f) && isField(f)) f.dispatchEvent(new Event('change'));
        closePalette({ focus: false });
        clearTimeout(compileTimer);
        clearTimeout(bannerTimer);
        if (saveTimer) { clearTimeout(saveTimer); saveView(); }
        if (viewFrame) cancelAnimationFrame(viewFrame);
        if (moveFrame) cancelAnimationFrame(moveFrame);
        document.removeEventListener('copy', onCopy, true);
        for (const d of disposers) (typeof d === 'function' ? d() : d.dispose());
        listeners.clear();
        selectListeners.clear();
      },
      graph: () => graph,
      selection: () => selectedIds(),
      select(ids) { select(ids || []); },
      centerOn,
      fit,
      view: () => ({ ...view }),
      setView: (v) => setView({ ...view, ...v }),
      errors: () => errors.slice(),
      markErrors(list) { clearTimeout(compileTimer); errors = Array.isArray(list) ? list : []; applyErrors(); },
      markRuntimeError(nodeId, message) { runtime = nodeId ? { node: nodeId, message: String(message || '') } : null; applyErrors(); },
      onChange(fn) { listeners.add(fn); return () => listeners.delete(fn); },
      // fn(ids) after the selection changed (a click, a box, select(), an edit that removed a selected node).
      onSelect(fn) { selectListeners.add(fn); return () => selectListeners.delete(fn); },
      openPalette: (point) => openPalette(point || centerPoint()),
      compileNow,
    };
    host.visualScript = api;
    return api;
  }

  VS.mountEditor = mountEditor;
})(window);
