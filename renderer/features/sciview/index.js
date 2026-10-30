// Scientific view, after PyCharm's SciView: the Data View (pandas, NumPy, polars and lists of dicts as paged tables)
// and the Plots tool window for matplotlib figures.
//
// The Data View never holds a whole table. A "source" evaluates Python where the object lives (the debugger's frame,
// the Python Console, a notebook kernel) and python/pyide_sciview.py answers with one block of rows and columns at a
// time, sorting and filtering on the Python side. Plots arrive from python/pyide_sciview_backend.py through
// main/features/sciview.js as 'sciview:plot'.
(() => {
  const { el, basename } = ide.util;
  const userText = (node) => { node.dataset.userText = ''; return node; };
  const count = (n) => Number(n).toLocaleString('en-US');

  // ---------- calling the Python helper ----------
  let helperDir = null;
  ide.api.invoke('sciview:helperDir').then((d) => { helperDir = d; }).catch(() => {});
  // The helpers folder is on PYTHONPATH for every process the IDE starts; the path fallback covers anything else.
  const helper = () => (helperDir
    ? `(__import__('sys').modules.get('pyide_sciview') or (__import__('sys').path.append(${JSON.stringify(helperDir)}), __import__('pyide_sciview'))[1])`
    : "__import__('pyide_sciview')");
  const toB64 = (text) => {
    const bytes = new TextEncoder().encode(text);
    let s = '';
    for (let i = 0; i < bytes.length; i += 0x8000) s += String.fromCharCode(...bytes.subarray(i, i + 0x8000));
    return btoa(s);
  };
  const fromB64 = (b64) => new TextDecoder().decode(Uint8Array.from(atob(b64), (c) => c.charCodeAt(0)));

  // English messages raised by pyide_sciview.py, translated here; anything else is the program's own error text.
  const PY_ERRORS = [
    [/^Cannot view a value of type (.+) as a table$/, (m) => tr('Cannot view a value of type {type} as a table', { type: m[1] })],
    [/^ValueError: The filter must give True or False for every row$/, () => tr('The filter must give True or False for every row')],
    [/^ValueError: The filter must give one True or False per row, for example (.+)$/, (m) => tr('The filter must give one True or False per row, for example {example}', { example: m[1] })],
    [/^ValueError: The slice (.+) still has (\d+) dimensions; the Data View shows one or two$/, (m) => tr('The slice {slice} still has {n} dimensions; the Data View shows one or two', { slice: m[1], n: m[2] })],
  ];
  const pyError = (msg) => {
    for (const [re, fn] of PY_ERRORS) { const m = re.exec(msg); if (m) return fn(m); }
    return msg;
  };

  async function pyCall(source, objExpr, req) {
    const expr = `${helper()}.call((${objExpr}), '${toB64(JSON.stringify(req))}')`;
    let raw = String(await source.evaluate(expr)).trim();
    const quoted = /^(['"])([A-Za-z0-9+/=]*)\1$/.exec(raw);
    if (quoted) raw = quoted[2];
    let res;
    try { res = JSON.parse(fromB64(raw)); } catch { throw new Error(raw); }
    if (res.error) throw Object.assign(new Error(pyError(res.error)), { unsupported: !!res.unsupported });
    return res;
  }

  // ---------- sources: where the Python objects live ----------
  // {id, label(), ready(), notReady(), evaluate(expr) -> Promise<str>, onChange(fn), gen}
  function makeSource({ subscribe, ...props }) {
    const listeners = new Set();
    const src = {
      ...props,
      gen: 0,
      onChange(fn) { listeners.add(fn); return () => listeners.delete(fn); },
      changed() { src.gen++; for (const fn of [...listeners]) fn(); },
    };
    subscribe(() => src.changed());
    return src;
  }

  const debuggerSource = ide.debugger?.evaluate ? makeSource({
    id: 'debugger',
    label: () => tr('Debugger'),
    ready: () => ide.debugger.isSuspended(),
    notReady: () => tr('The program is not suspended. The data refreshes when it stops at a breakpoint.'),
    async evaluate(expr) {
      if (!ide.debugger.isSuspended()) throw new Error(tr('The program is not suspended. The data refreshes when it stops at a breakpoint.'));
      const r = await ide.debugger.evaluate(expr, 'clipboard');
      if (r.error) throw new Error(r.error);
      return r.value;
    },
    subscribe: (fire) => ide.on('debugContextChanged', fire),
  }) : null;

  const consoleSource = ide.pyconsole?.evaluate ? makeSource({
    id: 'console',
    label: () => tr('Python Console'),
    ready: () => ide.pyconsole.isRunning(),
    notReady: () => tr('The Python Console is not running.'),
    async evaluate(expr) {
      if (!ide.pyconsole.isRunning()) throw new Error(tr('The Python Console is not running.'));
      return ide.pyconsole.evaluate(expr);
    },
    subscribe: (fire) => ide.on('pyconsoleChanged', fire),
  }) : null;

  const notebookSources = new WeakMap();
  const kernelDown = () => tr('The notebook kernel is not running. Run a cell to start it.');
  function notebookSource(view) {
    if (!notebookSources.has(view)) {
      notebookSources.set(view, makeSource({
        id: `nb:${view.path}`,
        label: () => basename(view.path),
        ready: () => view.kernel.running(),
        notReady: kernelDown,
        async evaluate(expr) {
          if (!view.kernel.running()) throw new Error(kernelDown());
          const r = await view.kernel.request('evaluate', { expr }, 120000);
          const v = r?.user_expressions?.r;
          if (!v) throw new Error(r?.status === 'aborted' ? tr('The kernel skipped the request after an error.') : tr('The kernel did not answer.'));
          if (v.status !== 'ok') throw new Error(`${v.ename}: ${v.evalue}`);
          return v.data?.['text/plain'] ?? '';
        },
        subscribe: (fire) => ide.on('notebookExecuted', (v) => { if (v === view) fire(); }),
      }));
    }
    return notebookSources.get(view);
  }

  const viewLink = (kind, run) => {
    const a = el('a', 'sv-view-link', kind === 'array' ? tr('View as Array') : tr('View as DataFrame'));
    a.href = '#';
    a.onmousedown = (e) => e.stopPropagation();
    a.onclick = (e) => { e.preventDefault(); e.stopPropagation(); run(); };
    return a;
  };

  // ---------- the Data View ----------
  const RH = 22; // row height
  const HEAD_H = 40;
  const ROW_BLOCK = 200;
  const COL_BLOCK = 40;
  const MAX_PX = 8e6; // taller content is scrolled proportionally
  const MAX_BLOCKS = 120;
  const COPY_LIMIT = 500000;
  const dataViews = new Map(); // tab id -> controller

  // {source, expr, title?} -> opens (or refreshes) the expression's Data View tab.
  function openDataView({ source, expr, title }) {
    const id = `dataview:${source.id}:${expr}`;
    const existing = dataViews.get(id);
    let dispose = null;
    const tab = ide.openCustomTab({
      id,
      title: title || expr,
      icon: 'dataView',
      mount(host, t) {
        const ctl = mountDataView(host, t, { source, expr });
        dataViews.set(id, ctl);
        dispose = ctl.dispose;
      },
      onClose: () => { dispose?.(); dataViews.delete(id); },
    });
    if (existing) existing.reload();
    return tab;
  }

  function mountDataView(host, tab, { source, expr }) {
    host.classList.add('dv-host');
    const st = {
      info: null, sort: null, filter: '', slice: '', heat: ide.settings.get('dataView.colored', false),
      blocks: new Map(), loading: new Map(), gen: 0, epoch: 0, widths: [], indexW: 64, sel: null, stats: new Map(), disposed: false,
    };

    // ----- DOM -----
    const bar = el('div', 'dv-bar');
    const titleEl = el('span', 'dv-title');
    const nameEl = userText(el('span', 'dv-name', expr));
    const typeEl = userText(el('span', 'dv-type'));
    titleEl.append(nameEl, typeEl);
    const sliceBox = el('label', 'dv-slice hidden');
    const sliceIn = el('input', 'dv-input dv-slice-in');
    sliceIn.spellcheck = false;
    sliceBox.append(el('span', 'dv-label', tr('Slice')), sliceIn);
    const filterIn = el('input', 'dv-input dv-filter');
    filterIn.spellcheck = false;
    filterIn.title = tr('Python filter expression; Enter applies it, an empty filter shows every row');
    const coloredBtn = el('button', 'dv-btn dv-colored', tr('Colored'));
    coloredBtn.title = tr('Color numeric cells by value');
    const refreshBtn = el('button', 'dv-btn dv-refresh');
    refreshBtn.appendChild(ide.icon('refresh'));
    refreshBtn.title = tr('Refresh');
    const exportBtn = el('button', 'dv-btn dv-export', tr('Export…'));
    exportBtn.title = tr('Export to CSV…');
    const status = el('span', 'dv-status');
    bar.append(titleEl, sliceBox, filterIn, coloredBtn, refreshBtn, exportBtn, el('span', 'dv-spacer'), status);
    const msg = el('div', 'dv-msg hidden');
    const grid = el('div', 'dv-grid');
    grid.tabIndex = 0;
    const head = userText(el('div', 'dv-head'));
    const scroller = el('div', 'dv-scroll');
    const sizer = el('div', 'dv-sizer');
    const layer = userText(el('div', 'dv-layer'));
    scroller.append(sizer, layer);
    grid.append(head, scroller);
    host.append(bar, msg, grid);

    const showMsg = (text, kind = 'info') => {
      msg.className = `dv-msg ${kind}`;
      msg.replaceChildren(userText(el('span', null, text)));
    };
    const hideMsg = () => { msg.className = 'dv-msg hidden'; };
    let flashTimer = 0;
    const setStatus = (text, flash) => {
      status.textContent = text;
      clearTimeout(flashTimer);
      if (flash) flashTimer = setTimeout(renderStatus, 2500);
    };

    // ----- geometry -----
    let colX = [0];
    const totalW = () => colX[colX.length - 1];
    function layoutColumns() {
      colX = [0];
      for (const w of st.widths) colX.push(colX[colX.length - 1] + w);
    }
    function vertical() {
      const rows = st.info?.rows || 0;
      const viewH = scroller.clientHeight;
      const fullH = rows * RH;
      const virtH = Math.min(fullH, MAX_PX);
      const maxScroll = Math.max(0, virtH - viewH);
      const offset = fullH > virtH && maxScroll > 0 ? (scroller.scrollTop / maxScroll) * Math.max(0, fullH - viewH) : scroller.scrollTop;
      const first = Math.min(Math.max(0, rows - 1), Math.floor(offset / RH));
      return { rows, viewH, fullH, virtH, maxScroll, first, shift: first * RH - offset, last: Math.min(rows - 1, Math.floor((offset + viewH) / RH)) };
    }
    function horizontal() {
      const left = scroller.scrollLeft;
      const viewW = scroller.clientWidth - st.indexW;
      let first = 0;
      let lo = 0;
      let hi = st.widths.length - 1;
      while (lo <= hi) { const mid = (lo + hi) >> 1; if (colX[mid + 1] <= left) lo = mid + 1; else { first = mid; hi = mid - 1; } }
      let last = first;
      while (last < st.widths.length - 1 && colX[last + 1] < left + viewW) last++;
      return { left, first, last: st.widths.length ? last : -1 };
    }
    function scrollTopForRow(r) {
      const v = vertical();
      const offset = r * RH;
      return v.fullH > v.virtH && v.maxScroll > 0 ? (offset / Math.max(1, v.fullH - v.viewH)) * v.maxScroll : offset;
    }
    function revealCell(r, c) {
      const v = vertical();
      if (r < v.first + 1 || r > v.last - 1) {
        const target = r < v.first + 1 ? r : r - Math.max(1, Math.floor(v.viewH / RH) - 2);
        scroller.scrollTop = scrollTopForRow(Math.max(0, target));
      }
      if (c >= 0) {
        const viewW = scroller.clientWidth - st.indexW;
        if (colX[c] < scroller.scrollLeft) scroller.scrollLeft = colX[c];
        else if (colX[c + 1] > scroller.scrollLeft + viewW) scroller.scrollLeft = colX[c + 1] - viewW;
      }
    }

    // ----- data blocks -----
    const blockKey = (rb, cb) => `${rb}:${cb}`;
    const baseReq = () => ({ key: expr, slice: st.slice, filter: st.filter, sort: st.sort, gen: `${source.gen}.${st.gen}` });
    function cell(r, c) {
      const b = st.blocks.get(blockKey(Math.floor(r / ROW_BLOCK), Math.floor(c / COL_BLOCK)));
      return b ? b.cells[r - b.start]?.[c - b.colStart] : undefined;
    }
    function indexLabel(r) {
      const rb = Math.floor(r / ROW_BLOCK);
      for (let cb = 0; cb <= Math.floor(Math.max(0, st.widths.length - 1) / COL_BLOCK); cb++) {
        const b = st.blocks.get(blockKey(rb, cb));
        if (b) return b.index[r - b.start];
      }
      return undefined;
    }
    function loadBlock(rb, cb) {
      const key = blockKey(rb, cb);
      if (st.blocks.has(key)) return Promise.resolve(st.blocks.get(key));
      if (st.loading.has(key)) return st.loading.get(key);
      const epoch = st.epoch;
      const p = pyCall(source, expr, { ...baseReq(), op: 'page', start: rb * ROW_BLOCK, count: ROW_BLOCK, colStart: cb * COL_BLOCK, colCount: COL_BLOCK, heat: st.heat })
        .then((b) => {
          if (epoch !== st.epoch) return null;
          st.blocks.set(key, b);
          for (const [ci, s] of Object.entries(b.stats || {})) if (s) st.stats.set(Number(ci), s);
          while (st.blocks.size > MAX_BLOCKS) st.blocks.delete(st.blocks.keys().next().value);
          fitIndex(b.index);
          return b;
        })
        .finally(() => { if (epoch === st.epoch) st.loading.delete(key); });
      st.loading.set(key, p);
      return p;
    }
    function fitIndex(labels) {
      const longest = Math.max(String(st.info.rows).length, ...labels.map((l) => String(l).length), (st.info.indexName || '').length);
      const w = Math.min(260, Math.max(48, longest * 7.4 + 18));
      if (w > st.indexW) { st.indexW = w; scheduleDraw(); }
    }
    function neededBlocks() {
      if (!st.info?.rows || !st.widths.length) return [];
      const v = vertical();
      const h = horizontal();
      const out = [];
      for (let rb = Math.floor(v.first / ROW_BLOCK); rb <= Math.floor(v.last / ROW_BLOCK); rb++) {
        for (let cb = Math.floor(h.first / COL_BLOCK); cb <= Math.floor(h.last / COL_BLOCK); cb++) out.push([rb, cb]);
      }
      return out;
    }
    let loadTimer = 0;
    let loadingNow = false;
    let loadAgain = false;
    const scheduleLoad = (delay = 40) => { clearTimeout(loadTimer); loadTimer = setTimeout(loadVisible, delay); };
    async function loadVisible() {
      if (loadingNow) { loadAgain = true; return; }
      loadingNow = true;
      try {
        for (;;) {
          const next = neededBlocks().find(([rb, cb]) => !st.blocks.has(blockKey(rb, cb)));
          if (!next || st.disposed) break;
          const epoch = st.epoch;
          try { await loadBlock(...next); } catch (e) {
            if (epoch === st.epoch) showError(e);
            break;
          }
          scheduleDraw();
        }
      } finally {
        loadingNow = false;
        if (loadAgain) { loadAgain = false; scheduleLoad(0); }
      }
    }

    // ----- drawing -----
    let drawPending = false;
    function scheduleDraw() {
      if (drawPending) return;
      drawPending = true;
      requestAnimationFrame(() => { drawPending = false; draw(); });
    }
    const esc = (s) => String(s).replace(/[&<>"]/g, (ch) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' })[ch]);
    function selRect() {
      const s = st.sel;
      if (!s) return null;
      return { r0: Math.min(s.r0, s.r1), r1: Math.max(s.r0, s.r1), c0: Math.min(s.c0, s.c1), c1: Math.max(s.c0, s.c1) };
    }
    function heatColor(c, text) {
      if (!st.heat || !st.info.columns[c]?.numeric || typeof text !== 'string') return '';
      const s = st.stats.get(c);
      const v = parseFloat(text);
      if (!s || s[0] === null || s[1] === null || !Number.isFinite(v)) return '';
      const t = s[1] > s[0] ? (v - s[0]) / (s[1] - s[0]) : 0.5;
      return `background:hsla(${Math.round(230 - 230 * Math.min(1, Math.max(0, t)))},75%,52%,0.38);`;
    }
    function draw() {
      if (st.disposed || !st.info) return;
      const v = vertical();
      const h = horizontal();
      const viewW = scroller.clientWidth;
      sizer.style.width = `${st.indexW + totalW()}px`;
      sizer.style.height = `${v.virtH}px`;
      layer.style.transform = `translate(${scroller.scrollLeft}px, ${scroller.scrollTop}px)`;
      layer.style.width = `${viewW}px`;
      layer.style.height = `${v.viewH}px`;
      const sel = selRect();
      const parts = [];
      for (let r = v.first; r <= v.last && v.rows; r++) {
        const y = v.shift + (r - v.first) * RH;
        const rowSel = sel && r >= sel.r0 && r <= sel.r1;
        for (let c = h.first; c <= h.last; c++) {
          const x = st.indexW + colX[c] - h.left;
          const val = cell(r, c);
          const isSel = rowSel && c >= sel.c0 && c <= sel.c1;
          const cls = `dv-c${st.info.columns[c].numeric ? ' num' : ''}${isSel ? ' sel' : ''}${val === undefined ? ' wait' : Array.isArray(val) ? ' null' : ''}${st.sel && st.sel.r1 === r && st.sel.c1 === c ? ' focus' : ''}`;
          const text = val === undefined ? '…' : Array.isArray(val) ? val[0] : val;
          parts.push(`<div class="${cls}" data-r="${r}" data-c="${c}" style="left:${x}px;top:${y}px;width:${st.widths[c]}px;${heatColor(c, val)}">${esc(text)}</div>`);
        }
        const label = indexLabel(r);
        parts.push(`<div class="dv-i${rowSel ? ' sel' : ''}" data-r="${r}" data-c="-1" style="top:${y}px;width:${st.indexW}px">${esc(label ?? '…')}</div>`);
      }
      layer.innerHTML = parts.join('');
      // Header: column names and dtypes, sort marks, resize handles.
      const hp = [`<div class="dv-corner" style="width:${st.indexW}px">${esc(st.info.indexName || '')}</div>`];
      for (let c = h.first; c <= h.last; c++) {
        const col = st.info.columns[c];
        const x = st.indexW + colX[c] - h.left;
        const mark = st.sort?.[0] === c ? (st.sort[1] ? ' ▲' : ' ▼') : '';
        const isSel = sel && c >= sel.c0 && c <= sel.c1;
        hp.push(`<div class="dv-h${col.numeric ? ' num' : ''}${isSel ? ' sel' : ''}" data-c="${c}" style="left:${x}px;width:${st.widths[c]}px" title="${esc(`${col.name}: ${col.dtype}`)}"><span class="dv-hn">${esc(col.name)}${mark}</span><span class="dv-ht">${esc(col.dtype)}</span><span class="dv-rs" data-c="${c}"></span></div>`);
      }
      head.innerHTML = hp.join('');
      scheduleLoad();
    }

    function renderStatus() {
      if (!st.info) { status.textContent = ''; return; }
      const cols = st.info.columns.length;
      status.textContent = st.info.rows === st.info.total
        ? tr('{rows} rows × {cols} columns', { rows: count(st.info.rows), cols: count(cols) })
        : tr('{rows} of {total} rows × {cols} columns', { rows: count(st.info.rows), total: count(st.info.total), cols: count(cols) });
    }
    function showError(e) {
      showMsg(e?.message || String(e), 'error');
    }

    // ----- loading the table description -----
    let infoSeq = 0;
    // changes: {filter?, sort?, slice?}. A failed change (bad filter) leaves the view as it was and shows the error.
    async function reload(changes = {}) {
      if (st.disposed) return false;
      const my = ++infoSeq;
      if (!source.ready()) { showMsg(source.notReady(), 'warn'); return false; }
      const next = { filter: st.filter, sort: st.sort, slice: st.slice, ...changes };
      const gen = st.gen + 1;
      setStatus(tr('Loading…'));
      let info;
      try {
        info = await pyCall(source, expr, { key: expr, slice: next.slice, filter: next.filter, sort: next.sort, gen: `${source.gen}.${gen}`, op: 'info' });
      } catch (e) {
        if (my !== infoSeq) return false;
        renderStatus();
        showError(e);
        filterIn.classList.toggle('invalid', 'filter' in changes);
        return false;
      }
      if (my !== infoSeq || st.disposed) return false;
      filterIn.classList.remove('invalid');
      hideMsg();
      const sameColumns = st.info && st.info.columns.length === info.columns.length
        && st.info.columns.every((c, i) => c.name === info.columns[i].name);
      Object.assign(st, next);
      st.gen = gen;
      st.epoch++;
      st.blocks.clear();
      st.loading.clear();
      st.stats.clear();
      st.info = info;
      if (!sameColumns) {
        st.widths = info.columns.map((c) => Math.min(320, Math.max(c.numeric ? 84 : 110, Math.max(c.name.length, c.dtype.length) * 7.6 + 26)));
        st.sort = next.sort && next.sort[0] < info.columns.length ? next.sort : null;
      }
      layoutColumns();
      typeEl.textContent = ` {${info.type}${info.shape ? `: (${info.shape.join(', ')})` : ''}}`;
      sliceBox.classList.toggle('hidden', !(info.ndim > 2));
      sliceIn.value = info.slice || '';
      st.slice = info.slice || '';
      filterIn.placeholder = info.kind === 'array'
        ? (info.columns.length > 1 && !info.columns.some((c) => !/^\d+$/.test(c.name)) ? tr('Filter rows, e.g. x[:, 0] > 0.5') : tr('Filter rows, e.g. x > 0.5'))
        : tr("Filter rows, e.g. price > 100 and city == 'Seoul'");
      if (st.sel) st.sel = { r0: Math.min(st.sel.r0, info.rows - 1), r1: Math.min(st.sel.r1, info.rows - 1), c0: Math.min(st.sel.c0, info.columns.length - 1), c1: Math.min(st.sel.c1, info.columns.length - 1) };
      if (!info.rows) st.sel = null;
      renderStatus();
      host.dataset.rows = String(info.rows);
      host.dataset.gen = String(st.gen);
      draw();
      return true;
    }

    // ----- interaction -----
    filterIn.onkeydown = (e) => {
      e.stopPropagation();
      if (e.key === 'Enter') { scroller.scrollTop = 0; reload({ filter: filterIn.value.trim() }); }
      if (e.key === 'Escape') { filterIn.value = st.filter; filterIn.classList.remove('invalid'); grid.focus(); }
    };
    sliceIn.onkeydown = (e) => {
      e.stopPropagation();
      if (e.key === 'Enter') reload({ slice: sliceIn.value.trim(), sort: null, filter: '' }).then((ok) => { if (ok) filterIn.value = ''; });
    };
    const setColored = (on) => {
      st.heat = on;
      coloredBtn.classList.toggle('on', on);
      coloredBtn.setAttribute('aria-pressed', String(on));
      ide.settings.set('dataView.colored', on);
      if (on) { st.blocks.clear(); st.loading.clear(); st.epoch++; }
      scheduleDraw();
    };
    coloredBtn.classList.toggle('on', st.heat);
    coloredBtn.setAttribute('aria-pressed', String(st.heat));
    coloredBtn.onclick = () => setColored(!st.heat);
    refreshBtn.onclick = () => reload();
    exportBtn.onclick = () => exportCsv();

    function cycleSort(c) {
      const next = st.sort?.[0] !== c ? [c, true] : st.sort[1] ? [c, false] : null;
      reload({ sort: next });
    }

    scroller.addEventListener('scroll', scheduleDraw);
    const ro = ide.util.observeSize(scroller, () => scheduleDraw());

    let drag = null;
    const target = (e) => e.target.closest?.('[data-r]');
    layer.addEventListener('mousedown', (e) => {
      const t = target(e);
      if (!t || e.button !== 0) return;
      grid.focus();
      const r = Number(t.dataset.r);
      const c = Number(t.dataset.c);
      const last = st.widths.length - 1;
      if (c < 0) st.sel = e.shiftKey && st.sel ? { ...st.sel, r1: r, c0: 0, c1: last } : { r0: r, r1: r, c0: 0, c1: last };
      else st.sel = e.shiftKey && st.sel ? { ...st.sel, r1: r, c1: c } : { r0: r, r1: r, c0: c, c1: c };
      drag = { row: c < 0 };
      scheduleDraw();
      e.preventDefault();
    });
    layer.addEventListener('mousemove', (e) => {
      if (!drag || !(e.buttons & 1)) { drag = null; return; }
      const t = target(e);
      if (!t) return;
      st.sel.r1 = Number(t.dataset.r);
      if (!drag.row) st.sel.c1 = Math.max(0, Number(t.dataset.c));
      scheduleDraw();
    });
    // On the window, so a drag released outside the grid ends; removed on dispose, since it keeps the whole view alive.
    const endDrag = () => { drag = null; };
    addEventListener('mouseup', endDrag);
    layer.addEventListener('contextmenu', (e) => {
      e.preventDefault();
      const t = target(e);
      if (t) {
        const r = Number(t.dataset.r);
        const c = Math.max(0, Number(t.dataset.c));
        const s = selRect();
        if (!s || r < s.r0 || r > s.r1 || c < s.c0 || c > s.c1) st.sel = { r0: r, r1: r, c0: c, c1: c };
        scheduleDraw();
      }
      ide.ui.contextMenu(e.clientX, e.clientY, [
        { label: tr('Copy'), hint: 'Ctrl+C', disabled: !st.sel, run: () => copySelection('tsv', false) },
        { label: tr('Copy with Headers'), disabled: !st.sel, run: () => copySelection('tsv', true) },
        { label: tr('Copy as CSV'), disabled: !st.sel, run: () => copySelection('csv', true) },
        { separator: true },
        { label: tr('Select All'), hint: 'Ctrl+A', run: selectAll },
        { label: tr('Export to CSV…'), run: exportCsv },
      ]);
    });

    head.addEventListener('mousedown', (e) => {
      const rs = e.target.closest('.dv-rs');
      if (rs) {
        e.preventDefault();
        e.stopPropagation();
        const c = Number(rs.dataset.c);
        const startX = e.clientX;
        const startW = st.widths[c];
        const move = (ev) => { st.widths[c] = Math.max(36, Math.round(startW + ev.clientX - startX)); layoutColumns(); scheduleDraw(); };
        const up = () => { removeEventListener('mousemove', move); removeEventListener('mouseup', up); };
        addEventListener('mousemove', move);
        addEventListener('mouseup', up);
      }
    });
    head.addEventListener('click', (e) => {
      if (e.target.closest('.dv-rs')) return;
      const h = e.target.closest('.dv-h');
      if (h) cycleSort(Number(h.dataset.c));
    });
    head.addEventListener('dblclick', (e) => {
      const rs = e.target.closest('.dv-rs');
      if (!rs) return;
      const c = Number(rs.dataset.c);
      // Fit the column to its loaded values.
      const v = vertical();
      let longest = Math.max(st.info.columns[c].name.length, st.info.columns[c].dtype.length);
      for (let r = v.first; r <= v.last; r++) {
        const val = cell(r, c);
        if (val !== undefined) longest = Math.max(longest, String(Array.isArray(val) ? val[0] : val).length);
      }
      st.widths[c] = Math.min(600, Math.max(40, longest * 7.6 + 20));
      layoutColumns();
      scheduleDraw();
    });

    function selectAll() {
      if (!st.info?.rows) return;
      st.sel = { r0: 0, c0: 0, r1: st.info.rows - 1, c1: st.widths.length - 1 };
      scheduleDraw();
    }
    grid.addEventListener('keydown', (e) => {
      if (!st.info) return;
      const key = `${e.ctrlKey ? 'Ctrl+' : ''}${e.key}`;
      if (key === 'Ctrl+c' || key === 'Ctrl+C') { e.preventDefault(); e.stopPropagation(); copySelection('tsv', false); return; }
      if (key === 'Ctrl+a' || key === 'Ctrl+A') { e.preventDefault(); e.stopPropagation(); selectAll(); return; }
      const moves = { ArrowUp: [-1, 0], ArrowDown: [1, 0], ArrowLeft: [0, -1], ArrowRight: [0, 1] };
      const page = Math.max(1, Math.floor(scroller.clientHeight / RH) - 1);
      let d = moves[e.key];
      if (e.key === 'PageDown') d = [page, 0];
      if (e.key === 'PageUp') d = [-page, 0];
      if (e.key === 'Home') d = e.ctrlKey ? [-Infinity, -Infinity] : [0, -Infinity];
      if (e.key === 'End') d = e.ctrlKey ? [Infinity, Infinity] : [0, Infinity];
      if (!d) return;
      e.preventDefault();
      e.stopPropagation();
      const cur = st.sel || { r0: 0, c0: 0, r1: 0, c1: 0 };
      const r = Math.min(st.info.rows - 1, Math.max(0, (st.sel ? cur.r1 : 0) + d[0]));
      const c = Math.min(st.widths.length - 1, Math.max(0, (st.sel ? cur.c1 : 0) + d[1]));
      st.sel = e.shiftKey && st.sel ? { ...st.sel, r1: r, c1: c } : { r0: r, r1: r, c0: c, c1: c };
      revealCell(r, c);
      scheduleDraw();
    });

    async function copySelection(format, headers) {
      const s = selRect();
      if (!s) return;
      const cellsCount = (s.r1 - s.r0 + 1) * (s.c1 - s.c0 + 1);
      if (cellsCount > COPY_LIMIT) {
        setStatus(tr('The selection has {n} cells; copy up to {max} or use Export to CSV…', { n: count(cellsCount), max: count(COPY_LIMIT) }), true);
        return;
      }
      setStatus(tr('Copying…'));
      try {
        for (let rb = Math.floor(s.r0 / ROW_BLOCK); rb <= Math.floor(s.r1 / ROW_BLOCK); rb++) {
          for (let cb = Math.floor(s.c0 / COL_BLOCK); cb <= Math.floor(s.c1 / COL_BLOCK); cb++) await loadBlock(rb, cb);
        }
      } catch (e) { renderStatus(); showError(e); return; }
      const sep = format === 'csv' ? ',' : '\t';
      const quote = (v) => {
        const text = v === undefined || Array.isArray(v) ? '' : String(v);
        if (format === 'csv') return /[",\r\n]/.test(text) ? `"${text.replace(/"/g, '""')}"` : text;
        return text.replace(/[\t\r\n]+/g, ' ');
      };
      const lines = [];
      if (headers) {
        const names = [];
        for (let c = s.c0; c <= s.c1; c++) names.push(quote(st.info.columns[c].name));
        lines.push([quote(st.info.indexName || ''), ...names].join(sep));
      }
      for (let r = s.r0; r <= s.r1; r++) {
        const row = [];
        for (let c = s.c0; c <= s.c1; c++) row.push(quote(cell(r, c)));
        lines.push((headers ? [quote(indexLabel(r)), ...row] : row).join(sep));
      }
      await ide.api.invoke('clipboard:writeText', `${lines.join('\r\n')}${s.r1 > s.r0 ? '\r\n' : ''}`);
      setStatus(tr('Copied {n} cells', { n: count(cellsCount) }), true);
      scheduleDraw();
    }

    async function exportCsv(file) {
      if (!st.info) return null;
      const name = expr.replace(/[^\w.-]+/g, '_').replace(/^_+|_+$/g, '') || 'data';
      file ||= await ide.api.invoke('sciview:savePath', 'csv', `${name}.csv`);
      if (!file) return null;
      setStatus(tr('Exporting…'));
      try {
        const r = await pyCall(source, expr, { ...baseReq(), op: 'csv', path: file, sep: /\.(tsv|txt)$/i.test(file) ? '\t' : ',' });
        setStatus(tr('Saved {rows} rows to {file}', { rows: count(r.rows), file: basename(file) }), true);
        return file;
      } catch (e) {
        renderStatus();
        showError(e);
        return null;
      }
    }

    // ----- life cycle -----
    let refreshTimer = 0;
    const unsub = source.onChange(() => {
      clearTimeout(refreshTimer);
      refreshTimer = setTimeout(() => {
        if (source.ready()) reload();
        else showMsg(source.notReady(), 'warn');
      }, 120);
    });
    nameEl.title = `${expr} · ${source.label()}`;
    reload();

    const ctl = {
      host,
      reload: () => reload(),
      state: () => ({ ...st, blocks: st.blocks.size }),
      cellText: (r, c) => { const v = cell(r, c); return Array.isArray(v) ? v[0] : v; },
      isMissing: (r, c) => Array.isArray(cell(r, c)),
      indexLabel,
      setFilter: (text) => { filterIn.value = text; scroller.scrollTop = 0; return reload({ filter: text.trim() }); },
      setSort: (c, asc) => reload({ sort: c === null ? null : [c, asc] }),
      setSlice: (text) => { sliceIn.value = text; return reload({ slice: text, sort: null, filter: '' }); },
      setColored,
      scrollToRow: (r) => { scroller.scrollTop = scrollTopForRow(r); scheduleDraw(); },
      select: (r0, c0, r1 = r0, c1 = c0) => { st.sel = { r0, c0, r1, c1 }; scheduleDraw(); },
      copy: (format = 'tsv', headers = false) => copySelection(format, headers),
      exportCsv,
      setWidth: (c, w) => { st.widths[c] = w; layoutColumns(); scheduleDraw(); },
      dispose() {
        st.disposed = true;
        unsub();
        clearTimeout(refreshTimer);
        clearTimeout(loadTimer);
        clearTimeout(flashTimer);
        removeEventListener('mouseup', endDrag);
        ro.disconnect();
      },
    };
    host.dataView = ctl;
    tab.dataView = ctl;
    return ctl;
  }

  // ---------- variables lists (Python Console, Jupyter Variables) ----------
  function variablesView(source, { empty = () => tr('No variables') } = {}) {
    const root = el('div', 'sv-vars');
    root.tabIndex = 0;
    let seq = 0;
    let timer = 0;
    let loads = 0;
    const rows = new Map(); // name -> row element, reused while the variable looks the same
    const visible = () => root.isConnected && root.offsetParent !== null;
    const row = (v) => {
      const sig = JSON.stringify(v);
      const old = rows.get(v.name);
      if (old?.sig === sig) return old.el;
      const r = el('div', 'sv-var');
      rows.set(v.name, { sig, el: r });
      const name = userText(el('span', 'sv-var-name', v.name));
      name.title = `${v.name} = ${v.value}`;
      const shape = v.shape ? `: (${v.shape.join(', ')})` : '';
      r.append(name, el('span', 'sv-var-eq', ' = '), userText(el('span', 'sv-var-type', `{${v.type}${shape}} `)), userText(el('span', 'sv-var-value', v.value)));
      r.dataset.name = v.name;
      if (v.kind) {
        const open = () => openDataView({ source, expr: v.name });
        r.append(viewLink(v.kind, open));
        r.ondblclick = open;
      }
      return r;
    };
    async function refresh() {
      if (!visible()) { root.dataset.dirty = 'true'; return; }
      delete root.dataset.dirty;
      const my = ++seq;
      if (!source.ready()) { root.replaceChildren(el('div', 'sv-empty', source.notReady())); return; }
      let vars;
      try {
        ({ vars } = await pyCall(source, 'globals()', { op: 'vars' }));
      } catch (e) {
        if (my === seq) root.replaceChildren(userText(el('div', 'sv-empty sv-error', e.message)));
        return;
      }
      if (my !== seq) return;
      const names = new Set(vars.map((v) => v.name));
      for (const name of [...rows.keys()]) if (!names.has(name)) rows.delete(name);
      const next = vars.map(row);
      if (next.length !== root.children.length || next.some((n, i) => root.children[i] !== n)) root.replaceChildren(...next);
      if (!vars.length) root.appendChild(el('div', 'sv-empty', empty()));
      root.dataset.loaded = String(++loads);
    }
    const unsub = source.onChange(() => { clearTimeout(timer); timer = setTimeout(refresh, 100); });
    return { el: root, refresh, dispose: () => { unsub(); clearTimeout(timer); } };
  }

  // The Python Console's Variables pane; pyconsole places it beside the console.
  function consoleVariables() {
    const list = variablesView(consoleSource);
    const pane = el('div', 'pyc-vars-pane');
    pane.id = 'pyconsoleVars';
    pane.append(el('div', 'pyc-vars-head', tr('Variables')), list.el);
    return { el: pane, refresh: list.refresh, dispose: list.dispose };
  }

  // ---------- integrations ----------
  // Debugger Variables and Watches: debugpy reports the type name and evaluateName of each value.
  function debugKind(v) {
    if (['DataFrame', 'Series'].includes(v.type)) return 'frame';
    if (['ndarray', 'matrix', 'MaskedArray', 'memmap'].includes(v.type)) return 'array';
    if (['list', 'tuple'].includes(v.type) && /^[[(]\s*\{/.test(v.value || '')) return 'frame';
    return null;
  }
  if (debuggerSource && ide.debugger.addVariableDecorator) {
    ide.debugger.addVariableDecorator((row, v, expr) => {
      const kind = expr && debugKind(v);
      if (!kind) return;
      // Before the value, which is the part that gets cut off in a narrow pane.
      const link = viewLink(kind, () => openDataView({ source: debuggerSource, expr }));
      link.classList.add('sv-before-value');
      row.insertBefore(link, row.querySelector('.dbg-value'));
    });
  }

  // Notebook results: Out[n] keeps the value of each execute_result in the kernel.
  function outputKind(data = {}) {
    const html = [].concat(data['text/html'] || []).join('');
    const text = [].concat(data['text/plain'] || []).join('');
    if (/class="dataframe/.test(html)) return 'frame';
    if (/^array\(/.test(text) || /^masked_array\(/.test(text)) return 'array';
    if (/^shape: \(\d+, \d+\)|^shape: \(\d+,\)/.test(text)) return 'frame';
    if (/\n(Name: .*, )?(Length: \d+, )?dtype: \w+$/.test(text)) return 'frame';
    if (/^\[\{/.test(text)) return 'frame';
    return null;
  }
  if (ide.notebook?.addOutputDecorator) {
    ide.notebook.addOutputDecorator((wrap, o, ctx) => {
      if (o.output_type !== 'execute_result' || typeof o.execution_count !== 'number') return;
      const kind = outputKind(o.data);
      if (!kind) return;
      const links = el('div', 'sv-out-links');
      links.appendChild(viewLink(kind, () => {
        const view = ctx.host?.notebook;
        if (view) openDataView({ source: notebookSource(view), expr: `Out[${o.execution_count}]`, title: `Out[${o.execution_count}] · ${basename(view.path)}` });
      }));
      wrap.appendChild(links);
    });
  }

  // Jupyter Variables tool window: the kernel namespace of the notebook in front (or the last one used).
  let lastNotebook = null;
  let jvHost = null;
  let jvList = null;
  let jvFor = null;
  const openNotebook = () => {
    const front = ide.activeTab()?.notebook;
    if (front) lastNotebook = front;
    return lastNotebook && ide.tabs.includes(lastNotebook.tab) ? lastNotebook : null;
  };
  function renderJupyterVariables() {
    if (!jvHost) return;
    const view = openNotebook();
    if (view !== jvFor) {
      jvList?.dispose();
      jvFor = view;
      jvList = view ? variablesView(notebookSource(view)) : null;
      const headText = view ? userText(el('div', 'sv-jv-head', basename(view.path))) : null;
      jvHost.replaceChildren(...(view ? [headText, jvList.el] : [el('div', 'sv-empty', tr('Open a notebook to see the variables of its kernel.'))]));
    }
    jvList?.refresh();
  }
  if (ide.notebook) {
    const jvTw = ide.registerToolWindow({
      id: 'JupyterVariables', title: tr('Jupyter Variables'), icon: '𝑥', iconName: 'jupyterVariables', side: 'bottom', order: 66,
      mount(container) {
        container.classList.add('sv-jv');
        jvHost = container;
      },
    });
    jvTw.setActions([{ icon: 'refresh', title: tr('Refresh'), run: () => jvList?.refresh() }]);
    ide.on('toolWindowShown', (id) => { if (id === 'JupyterVariables') renderJupyterVariables(); });
    ide.on('activeTabChanged', (tab) => { if (tab?.notebook && jvTw.isVisible()) renderJupyterVariables(); });
    ide.on('fileClosed', () => { if (jvTw.isVisible()) setTimeout(renderJupyterVariables); });
  }

  // ---------- Plots tool window ----------
  const plots = [];
  let current = -1;
  let zoom = 'fit';
  let plotSeq = 0;
  let plotsEls = null;

  const zoomLevels = [0.1, 0.25, 0.33, 0.5, 0.67, 0.75, 0.9, 1, 1.25, 1.5, 2, 3, 4, 6, 8];
  function setZoom(z) {
    zoom = z;
    renderPlot();
  }
  function zoomBy(dir) {
    const p = plots[current];
    if (!p) return;
    const img = plotsEls.img;
    const now = zoom === 'fit' ? img.clientWidth / (p.width / 2) : zoom;
    const next = dir > 0 ? zoomLevels.find((z) => z > now + 1e-3) : [...zoomLevels].reverse().find((z) => z < now - 1e-3);
    if (next) setZoom(next);
  }
  function renderPlot() {
    if (!plotsEls) return;
    const p = plots[current];
    const { view, img, empty, info, strip } = plotsEls;
    plotsEls.root.dataset.count = String(plots.length);
    empty.classList.toggle('hidden', !!p);
    view.classList.toggle('hidden', !p);
    for (const b of plotsEls.needPlot) b.disabled = !p;
    plotsEls.svgBtn.disabled = !p?.svg;
    renderStrip(strip);
    if (!p) { info.textContent = ''; return; }
    img.src = `data:image/png;base64,${p.png}`;
    view.classList.toggle('fit', zoom === 'fit');
    img.style.width = zoom === 'fit' ? '' : `${Math.round((p.width / 2) * zoom)}px`;
    info.textContent = `${p.title} · ${p.source}${zoom === 'fit' ? '' : ` · ${Math.round(zoom * 100)}%`}`;
    strip.querySelector('.active')?.scrollIntoView({ block: 'nearest', inline: 'nearest' });
  }
  // History thumbnails, made once per plot: a new plot adds one image instead of decoding all hundred again.
  const thumbs = new Map(); // plot id -> its button in the strip
  function thumbFor(q) {
    let t = thumbs.get(q.id);
    if (t) return t;
    t = el('button', 'sv-thumb');
    const ti = el('img');
    ti.src = `data:image/png;base64,${q.png}`;
    ti.alt = '';
    t.appendChild(ti);
    userText(t).title = `${q.title} · ${q.source} · ${q.time}`;
    t.onclick = () => { current = plots.indexOf(q); renderPlot(); };
    t.oncontextmenu = (e) => {
      e.preventDefault();
      const i = plots.indexOf(q);
      current = i;
      renderPlot();
      ide.ui.contextMenu(e.clientX, e.clientY, [
        { label: tr('Save as PNG…'), run: () => savePlot(i, 'png') },
        { label: tr('Save as SVG…'), disabled: !q.svg, run: () => savePlot(i, 'svg') },
        { label: tr('Copy Image'), run: () => copyPlot(i) },
        { separator: true },
        { label: tr('Delete Plot'), run: () => deletePlot(i) },
      ]);
    };
    thumbs.set(q.id, t);
    return t;
  }
  function renderStrip(strip) {
    const live = new Set(plots.map((q) => q.id));
    for (const [id, t] of thumbs) if (!live.has(id)) { t.remove(); thumbs.delete(id); }
    plots.forEach((q, i) => {
      const t = thumbFor(q);
      if (strip.children[i] !== t) strip.insertBefore(t, strip.children[i] || null);
      t.dataset.index = String(i);
      t.classList.toggle('active', i === current);
    });
  }
  function addPlot(msg) {
    const plot = { ...msg, id: ++plotSeq, time: new Date().toLocaleTimeString() };
    const at = plots.findIndex((p) => p.key === msg.key);
    if (at >= 0) { plots[at] = plot; current = at; } else { plots.push(plot); current = plots.length - 1; }
    while (plots.length > 100) { plots.shift(); current = Math.max(0, current - 1); }
    zoom = 'fit';
    plotsTw.setBadge(String(plots.length));
    if (!plotsTw.isVisible()) plotsTw.show();
    renderPlot();
  }
  function deletePlot(i = current) {
    if (!plots[i]) return;
    plots.splice(i, 1);
    current = Math.min(current, plots.length - 1);
    plotsTw.setBadge(plots.length ? String(plots.length) : '');
    renderPlot();
  }
  function clearPlots() {
    plots.length = 0;
    current = -1;
    plotsTw.setBadge('');
    renderPlot();
  }
  async function savePlot(i = current, kind = 'png', file) {
    const p = plots[i];
    if (!p || (kind === 'svg' && !p.svg)) return null;
    const name = p.title.replace(/[^\w.-]+/g, '_').replace(/^_+|_+$/g, '') || 'plot';
    file ||= await ide.api.invoke('sciview:savePath', kind, `${name}.${kind}`);
    if (!file) return null;
    await ide.api.invoke('sciview:writePlot', file, kind, kind === 'png' ? p.png : p.svg);
    return file;
  }
  async function copyPlot(i = current) {
    const p = plots[i];
    if (!p) return false;
    try {
      const blob = await (await fetch(`data:image/png;base64,${p.png}`)).blob();
      await navigator.clipboard.write([new ClipboardItem({ 'image/png': blob })]);
      return true;
    } catch {
      return false;
    }
  }

  const plotsTw = ide.registerToolWindow({
    id: 'Plots', title: tr('Plots'), icon: '📈', iconName: 'plots', side: 'right', order: 40,
    mount(container) {
      container.classList.add('sv-plots');
      const toolbar = el('div', 'sv-plot-bar');
      // icon: an icon name, or a text label (PNG, SVG).
      const btn = (icon, title, run, cls = '') => {
        const b = el('button', `sv-pbtn ${cls}`);
        if (/^[a-z]/.test(icon)) b.appendChild(ide.icon(icon)); else b.textContent = icon;
        b.title = title;
        b.onclick = run;
        toolbar.appendChild(b);
        return b;
      };
      const needPlot = [
        btn('zoomOut', tr('Zoom Out'), () => zoomBy(-1), 'sv-zoom-out'),
        btn('zoomIn', tr('Zoom In'), () => zoomBy(1), 'sv-zoom-in'),
        btn('actualZoom', tr('Actual Size'), () => setZoom(1), 'sv-zoom-actual'),
        btn('fit', tr('Fit to Window'), () => setZoom('fit'), 'sv-zoom-fit'),
      ];
      toolbar.appendChild(el('span', 'sv-sep'));
      needPlot.push(btn('PNG', tr('Save as PNG…'), () => savePlot(current, 'png'), 'sv-save-png'));
      const svgBtn = btn('SVG', tr('Save as SVG…'), () => savePlot(current, 'svg'), 'sv-save-svg');
      needPlot.push(btn('copy', tr('Copy Image'), () => copyPlot(), 'sv-copy'));
      toolbar.appendChild(el('span', 'sv-sep'));
      needPlot.push(btn('remove', tr('Delete Plot'), () => deletePlot(), 'sv-delete'));
      needPlot.push(btn('clear', tr('Delete All Plots'), clearPlots, 'sv-clear'));
      const info = userText(el('div', 'sv-plot-info'));
      const view = el('div', 'sv-plot-view hidden fit');
      const img = el('img', 'sv-plot-img');
      img.alt = '';
      img.draggable = false;
      view.appendChild(img);
      view.addEventListener('wheel', (e) => {
        if (!e.ctrlKey) return;
        e.preventDefault();
        zoomBy(e.deltaY < 0 ? 1 : -1);
      }, { passive: false });
      const empty = el('div', 'sv-empty sv-plot-empty', tr('No plots yet. matplotlib figures appear here when a program calls plt.show().'));
      const strip = el('div', 'sv-plot-strip');
      container.append(toolbar, info, view, empty, strip);
      plotsEls = { root: container, view, img, empty, info, strip, needPlot, svgBtn };
      renderPlot();
    },
  });
  ide.api.on('sciview:plot', addPlot);

  // ---------- settings ----------
  const SHOW_PLOTS = 'plots.showInToolWindow';
  const configure = () => ide.api.invoke('sciview:configure', { showPlots: ide.settings.get(SHOW_PLOTS, true) });
  configure();
  ide.on('settingsChanged', (key) => { if (key === SHOW_PLOTS) configure(); });
  (ide.settingsPages ||= []).push({
    id: 'python-plots', title: () => tr('Python Plots'),
    keywords: 'plots matplotlib sciview scientific figure chart 플롯 그래프 차트 과학',
    mount(host, ctx) {
      const s = ctx.ui.section(host, tr('Plots'));
      const row = ctx.ui.checkbox(SHOW_PLOTS, tr('Show plots in tool window'));
      row.querySelector('input').id = 'svShowPlots';
      if (ctx.value(SHOW_PLOTS) === undefined) row.querySelector('input').checked = true;
      s.appendChild(row);
      host.appendChild(el('p', 'muted settings-note', tr('matplotlib figures from Run, Debug and the Python Console open in the Plots tool window instead of separate windows. Applies to programs started after the change; notebooks keep showing plots inline.')));
    },
  });

  // ---------- Install Manager: the scientific stack for the project interpreter ----------
  const PACKAGES = [
    ['numpy', 'NumPy', () => tr('N-dimensional arrays and numerical computing.')],
    ['pandas', 'pandas', () => tr('DataFrames for data analysis.')],
    ['matplotlib', 'Matplotlib', () => tr('Plots and figures; shown in the Plots tool window.')],
    ['polars', 'Polars', () => tr('Fast DataFrames built on Apache Arrow.')],
  ];
  const pipItems = new Map();
  function registerPackages() {
    if (!ide.installer?.pip) return;
    for (const [pkg, name, description] of PACKAGES) {
      if (pipItems.has(pkg) || ide.installables?.some((i) => i.id === `pip:${pkg}`)) continue;
      const item = ide.installer.pip({ package: pkg, name, description: description() });
      pipItems.set(pkg, item);
      ide.installer.register(item);
    }
  }
  ide.on('installablesChanged', registerPackages);
  registerPackages();

  ide.registerAction({ id: 'ShowPlots', title: tr('Plots'), run: () => plotsTw.show() });

  ide.dataView = {
    open: openDataView,
    variablesView,
    ...(consoleSource ? { consoleVariables } : {}),
    call: pyCall,
    sources: { debugger: debuggerSource, console: consoleSource, notebook: notebookSource },
    views: () => [...dataViews.values()],
  };
  ide.plots = {
    list: () => plots.map(({ png, svg, ...p }) => ({ ...p, hasSvg: !!svg, pngBytes: Math.round((png.length * 3) / 4) })),
    current: () => current,
    select: (i) => { current = i; renderPlot(); },
    zoom: () => zoom,
    setZoom,
    zoomBy,
    save: savePlot,
    copy: copyPlot,
    delete: deletePlot,
    clear: clearPlots,
  };
})();
