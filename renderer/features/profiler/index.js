// Profile: an executor that runs any run configuration under cProfile, and the Profiler tool window with PyCharm's
// Statistics table (sortable call count, time and own time), a call tree and a flame graph, all navigating to source.
// cProfile records caller -> callee totals, not stacks, so the tree splits a function's callees over its callers in
// proportion to time, as gprof-style viewers do. Recursive calls are folded into the outermost call.
(() => {
  const { el, basename, isUnder } = ide.util;
  const run = ide.run;
  if (!run?.registerExecutor) return;

  // PyCharm New UI icons (IntelliJ Platform, Apache License 2.0), with Gray7 as currentColor like renderer/core/icons.js.
  Object.assign(window.PYIDE_ICONS ||= {}, {
    profile: '<svg aria-hidden="true" width="16" height="16" viewBox="0 0 16 16" fill="none" xmlns="http://www.w3.org/2000/svg"> <path fill-rule="evenodd" clip-rule="evenodd" d="M9 9.50215C9 8.32441 10.2951 7.60608 11.2942 8.22967L15.2962 10.7275C16.2372 11.3149 16.2372 12.6851 15.2962 13.2725L11.2942 15.7703C10.2951 16.3939 9 15.6756 9 14.4978V9.50215ZM10.7647 9.07799C10.4317 8.87013 10 9.10957 10 9.50215V14.4978C10 14.8904 10.4317 15.1298 10.7647 14.922L14.7667 12.4241C15.0804 12.2284 15.0804 11.7716 14.7667 11.5758L10.7647 9.07799Z" fill="#208A3C"/> <path d="M10 9.50217C10 9.10959 10.4317 8.87015 10.7647 9.07801L14.7667 11.5758C15.0804 11.7716 15.0804 12.2284 14.7667 12.4242L10.7647 14.922C10.4317 15.1299 10 14.8904 10 14.4978V9.50217Z" fill="#F2FCF3"/> <path d="M1.5 9C1.5 5.41015 4.41015 2.5 8 2.5C11.5899 2.5 14.5 5.41015 14.5 9C14.5 9.01716 14.4999 9.03444 14.4997 9.05183L15.4651 9.65439C15.4879 9.42788 15.5 9.20815 15.5 9C15.5 4.85786 12.1421 1.5 8 1.5C3.85786 1.5 0.5 4.85786 0.5 9C0.5 10.1604 0.877241 11.6805 1.36637 12.7304C1.44463 12.8984 1.61594 13 1.80126 13H8V12H2.13917C1.76974 11.0874 1.5 9.89088 1.5 9Z" fill="currentColor"/> <path d="M8 10.6V9.6C7.55826 9.59989 7.2002 9.24176 7.2002 8.8C7.2002 8.35817 7.55837 8 8.0002 8C8.15213 8 8.29417 8.04235 8.41515 8.11589C8.60651 7.82993 8.85445 7.58935 9.13847 7.40554C8.97934 7.27549 8.79754 7.17214 8.5999 7.10232V3.99999C8.5999 3.66862 8.33127 3.39999 7.9999 3.39999C7.66853 3.39999 7.3999 3.66862 7.3999 3.99999V7.10253C6.70094 7.34971 6.2002 8.01638 6.2002 8.8C6.2002 9.79405 7.00598 10.5999 8 10.6Z" fill="currentColor"/> </svg>',
    profiler: '<svg aria-hidden="true" width="16" height="16" viewBox="0 0 16 16" fill="none" xmlns="http://www.w3.org/2000/svg"> <path fill-rule="evenodd" clip-rule="evenodd" d="M12.157 7.20214C12.4154 6.99461 12.4566 6.61695 12.249 6.35861C12.0415 6.10028 11.6638 6.0591 11.4055 6.26663L8.92772 8.25717C8.6568 8.09391 8.33937 8 8.00001 8C7.0059 8 6.20001 8.80589 6.20001 9.8C6.20001 10.7941 7.0059 11.6 8.00001 11.6C8.99412 11.6 9.80001 10.7941 9.80001 9.8C9.80001 9.58321 9.76169 9.37538 9.69144 9.18289L12.157 7.20214ZM8.80001 9.8C8.80001 10.2418 8.44184 10.6 8.00001 10.6C7.55818 10.6 7.20001 10.2418 7.20001 9.8C7.20001 9.35817 7.55818 9 8.00001 9C8.44184 9 8.80001 9.35817 8.80001 9.8Z" fill="currentColor"/> <path fill-rule="evenodd" clip-rule="evenodd" d="M8 3.5C4.41015 3.5 1.5 6.41015 1.5 10C1.5 10.8909 1.76974 12.0874 2.13917 13H13.8608C14.2303 12.0874 14.5 10.8909 14.5 10C14.5 6.41015 11.5899 3.5 8 3.5ZM0.5 10C0.5 5.85786 3.85786 2.5 8 2.5C12.1421 2.5 15.5 5.85786 15.5 10C15.5 11.1604 15.1228 12.6805 14.6336 13.7304C14.5554 13.8984 14.3841 14 14.1987 14H1.80126C1.61594 14 1.44463 13.8984 1.36637 13.7304C0.877241 12.6805 0.5 11.1604 0.5 10Z" fill="currentColor"/> </svg>',
  });

  let snapshot = null; // {name, cfg, time, fns, all (synthetic root node), total}

  // ---------- the executor ----------
  run.registerExecutor({
    id: 'Profile', title: tr('Profile'), iconName: 'profile', glyph: '◔',
    label: (name) => tr("Profile '{name}'", { name }),
    async prepare(cfg, interp, s) {
      // Remote interpreters (interp.target) run elsewhere, where the wrapper script is not.
      if (interp.target) {
        s.console().append(`${tr('Profiling works with local interpreters only.')}\n`, 'err');
        return null;
      }
      const job = await ide.api.invoke('profiler:prepare');
      s.exitHooks.push(() => collect(job, cfg, s));
      return { ...interp, args: [...interp.args, '-u', job.boot, job.stats, '--'] };
    },
  });

  async function collect(job, cfg, s) {
    const data = await ide.api.invoke('profiler:result', job.dir);
    if (!data) {
      s.con?.append(`${tr('No profiling data was collected: the process ended before the profiler could save it.')}\n`, 'err');
      return;
    }
    setSnapshot({ name: cfg.name, cfg, time: new Date(), data });
    tw.show();
  }

  // ---------- the snapshot: functions, callee lists and the call tree ----------
  const navigable = (fn) => !!fn && fn.file !== '~' && !!fn.file && !fn.file.startsWith('<');
  const location = (fn) => (navigable(fn) ? `${basename(fn.file)}:${fn.line}` : '');

  function setSnapshot({ name, cfg, time, data }) {
    const fns = data.functions.map((f, id) => ({ ...f, id, callees: [] }));
    for (const f of fns) for (const [ci, nc, , , ct] of f.callers) fns[ci].callees.push({ fn: f, nc, ct });
    const roots = fns.filter((f) => f.root).map((f) => ({ fn: f, time: f.root[3], calls: f.root[0], parent: null }));
    roots.sort((a, b) => b.time - a.time);
    const total = roots.reduce((a, r) => a + r.time, 0) || data.total || 0;
    const all = { fn: null, time: total, calls: 0, parent: null, children: roots, own: Math.max(0, total - roots.reduce((a, r) => a + r.time, 0)) };
    for (const r of roots) r.parent = all;
    snapshot = { name, cfg, time, fns, all, total };
    expanded = new Set();
    treeSelected = null;
    statsSelected = null;
    zoom = null;
    expandHotPath();
    render();
  }

  // A node's callees, splitting each callee's time from this function in proportion to the node's share of the
  // function's total time. Children never add up to more than their parent.
  function childrenOf(node) {
    if (node.children) return node.children;
    const f = node.fn;
    const scale = f.ct > 0 ? node.time / f.ct : 0;
    const onPath = (fn) => { for (let p = node; p; p = p.parent) if (p.fn === fn) return true; return false; };
    const kids = f.callees.filter((e) => !onPath(e.fn)).map((e) => ({ fn: e.fn, time: e.ct * scale, calls: e.nc, parent: node }));
    const sum = kids.reduce((a, k) => a + k.time, 0);
    if (sum > node.time && sum > 0) for (const k of kids) k.time *= node.time / sum;
    node.own = Math.max(0, node.time - Math.min(sum, node.time));
    node.children = kids.sort((a, b) => b.time - a.time);
    return node.children;
  }
  const ownOf = (node) => { childrenOf(node); return node.own; };
  const nodeKey = (node) => { const ids = []; for (let p = node; p?.fn; p = p.parent) ids.push(p.fn.id); return ids.reverse().join('/'); };

  // ---------- formatting ----------
  const ms = (sec) => {
    const v = sec * 1000;
    return v.toFixed(v >= 100 ? 0 : v >= 10 ? 1 : 2);
  };
  const share = (sec) => (snapshot?.total ? `${((100 * sec) / snapshot.total).toFixed(1)}%` : '');
  function nameCell(fn, cls = 'pf-name') {
    const c = el('span', cls);
    const label = el('span', 'pf-label', fn ? fn.name : tr('All calls'));
    if (fn) label.dataset.userText = '';
    c.appendChild(label);
    if (location(fn)) { const loc = el('span', 'pf-loc', location(fn)); loc.dataset.userText = ''; c.appendChild(loc); }
    return c;
  }
  function timeCell(sec, withShare) {
    const c = el('span', 'pf-num', ms(sec));
    if (withShare) c.appendChild(el('span', 'pf-share', share(sec)));
    return c;
  }

  // Marks a row selected in place, so the second click of a double-click lands on the same element.
  function markSelected(host, row) {
    host.querySelector('.selected')?.classList.remove('selected');
    row.classList.add('selected');
    host.focus();
  }

  function navigate(fn) {
    if (navigable(fn)) ide.openFile(fn.file, { line: Math.max(1, fn.line) });
  }

  // ---------- Profiler tool window ----------
  let header;
  let tabsEl;
  let panes = {};
  let activeTab = 'stats';
  const TABS = [['stats', () => tr('Statistics')], ['tree', () => tr('Call Tree')], ['flame', () => tr('Flame Graph')]];

  // registerToolWindow calls mount right away, before it returns, so mount keeps the tool window it is given.
  let tw = null;
  ide.registerToolWindow({
    id: 'Profiler', title: tr('Profiler'), iconName: 'profiler', icon: '◔', side: 'bottom', order: 66,
    mount(container, toolWindow) {
      tw = toolWindow;
      container.classList.add('pf-tool');
      header = el('div', 'pf-header');
      tabsEl = el('div', 'pf-tabs');
      for (const [id, title] of TABS) {
        const b = el('button', 'pf-tab', title());
        b.dataset.tab = id;
        b.onclick = () => showTab(id);
        tabsEl.appendChild(b);
      }
      const body = el('div', 'pf-body');
      panes = { stats: buildStats(), tree: buildTree(), flame: buildFlame() };
      for (const [id, pane] of Object.entries(panes)) { pane.root.dataset.pane = id; body.appendChild(pane.root); }
      container.append(header, tabsEl, body);
      ide.util.observeSize(body, () => activeTab === 'flame' && panes.flame.render());
      render();
    },
  });
  ide.on('toolWindowShown', (id) => id === 'Profiler' && activeTab === 'flame' && panes.flame?.render());

  function showTab(id) {
    activeTab = id;
    render();
  }

  function render() {
    if (!header) return;
    tw.setActions(snapshot ? [{ icon: '⟳', title: tr("Rerun '{name}' with Profiler", { name: snapshot.name }), run: () => run.runConfig(snapshot.cfg, { executor: 'Profile' }) }] : []);
    for (const b of tabsEl.children) b.classList.toggle('active', b.dataset.tab === activeTab);
    for (const [id, pane] of Object.entries(panes)) pane.root.classList.toggle('hidden', id !== activeTab);
    tabsEl.classList.toggle('hidden', !snapshot);
    if (!snapshot) {
      header.replaceChildren(el('span', 'muted', tr('No profiling results. Profile a configuration to see them here.')));
      for (const pane of Object.values(panes)) pane.root.classList.add('hidden');
      return;
    }
    const name = el('span', 'pf-snapshot', snapshot.name);
    name.dataset.userText = '';
    header.replaceChildren(name, el('span', 'pf-time', snapshot.time.toLocaleTimeString()),
      el('span', 'pf-total', tr('Total time: {time} ms', { time: ms(snapshot.total) })));
    panes[activeTab].render();
  }

  // ---------- Statistics ----------
  let statsSelected = null;
  const COLUMNS = [
    { id: 'name', title: () => tr('Name'), value: (f) => f.name.toLowerCase(), asc: true },
    { id: 'nc', title: () => tr('Call Count'), value: (f) => f.nc },
    { id: 'ct', title: () => tr('Time (ms)'), value: (f) => f.ct },
    { id: 'tt', title: () => tr('Own Time (ms)'), value: (f) => f.tt },
  ];
  const sort = { col: 'ct', desc: true };

  function buildStats() {
    const root = el('div', 'pf-pane pf-stats');
    const filter = el('input', 'pf-filter');
    filter.placeholder = tr('Filter by name or file');
    filter.oninput = () => paint();
    const head = el('div', 'pf-row pf-head');
    const rows = el('div', 'pf-rows');
    rows.tabIndex = 0;
    root.append(filter, head, rows);

    const visible = () => {
      const q = filter.value.trim().toLowerCase();
      const col = COLUMNS.find((c) => c.id === sort.col);
      const list = snapshot.fns.filter((f) => !q || f.name.toLowerCase().includes(q) || f.file.toLowerCase().includes(q));
      return list.sort((a, b) => {
        const va = col.value(a);
        const vb = col.value(b);
        const d = va < vb ? -1 : va > vb ? 1 : 0;
        return (sort.desc ? -d : d) || b.ct - a.ct;
      });
    };

    function paint() {
      head.replaceChildren(...COLUMNS.map((c) => {
        const h = el('span', `pf-col pf-col-${c.id}${sort.col === c.id ? ' sorted' : ''}`, c.title());
        h.dataset.col = c.id;
        if (sort.col === c.id) h.appendChild(el('span', 'pf-sort', sort.desc ? '▼' : '▲'));
        h.onclick = () => {
          if (sort.col === c.id) sort.desc = !sort.desc; else { sort.col = c.id; sort.desc = !c.asc; }
          paint();
        };
        return h;
      }));
      const frag = document.createDocumentFragment();
      for (const f of visible()) {
        const row = el('div', `pf-row pf-item${f === statsSelected ? ' selected' : ''}`);
        row.dataset.id = f.id;
        row.append(nameCell(f), el('span', 'pf-num', String(f.nc)), timeCell(f.ct, true), timeCell(f.tt, false));
        row.onclick = () => { statsSelected = f; markSelected(rows, row); };
        row.ondblclick = () => navigate(f);
        row.oncontextmenu = (e) => { e.preventDefault(); statsSelected = f; paint(); fnMenu(f, e.clientX, e.clientY); };
        frag.appendChild(row);
      }
      rows.replaceChildren(frag);
    }

    rows.onkeydown = (e) => {
      const list = visible();
      const i = list.indexOf(statsSelected);
      if (e.key === 'ArrowDown' || e.key === 'ArrowUp') {
        e.preventDefault();
        statsSelected = list[Math.max(0, Math.min(list.length - 1, i + (e.key === 'ArrowDown' ? 1 : -1)))] || null;
        paint();
        rows.querySelector('.selected')?.scrollIntoView({ block: 'nearest' });
      } else if ((e.key === 'Enter' || e.key === 'F4') && statsSelected) {
        e.preventDefault();
        e.stopPropagation();
        navigate(statsSelected);
      }
    };
    return { root, render: paint };
  }

  function fnMenu(fn, x, y) {
    ide.ui.contextMenu(x, y, [
      { label: tr('Navigate to Source'), hint: 'F4', disabled: !navigable(fn), run: () => navigate(fn) },
      { label: tr('Show on Call Tree'), run: () => revealInTree(fn) },
      { label: tr('Show on Flame Graph'), run: () => revealInFlame(fn) },
    ]);
  }

  // The heaviest node that calls fn (breadth first over the hot children), or null.
  function findNode(fn) {
    const queue = [...snapshot.all.children];
    let best = null;
    for (let seen = 0; queue.length && seen < 5000; seen++) {
      const n = queue.shift();
      if (n.fn === fn && (!best || n.time > best.time)) best = n;
      if (!best) queue.push(...childrenOf(n));
    }
    return best;
  }

  // ---------- Call Tree ----------
  let expanded = new Set(); // node keys
  let treeSelected = null;

  function expandHotPath() {
    let node = snapshot.all.children[0];
    for (let depth = 0; node && depth < 30; depth++) {
      expanded.add(nodeKey(node));
      const next = childrenOf(node)[0];
      if (!next || next.time < snapshot.total * 0.01) break;
      node = next;
    }
  }

  function buildTree() {
    const root = el('div', 'pf-pane pf-tree');
    const head = el('div', 'pf-row pf-head');
    head.append(el('span', 'pf-col', tr('Name')), el('span', 'pf-col', tr('Call Count')), el('span', 'pf-col', tr('Time (ms)')), el('span', 'pf-col', tr('Own Time (ms)')));
    const rows = el('div', 'pf-rows');
    rows.tabIndex = 0;
    root.append(head, rows);

    const visibleRows = () => {
      const out = [];
      const walk = (n, depth) => {
        out.push([n, depth]);
        if (expanded.has(nodeKey(n))) for (const c of childrenOf(n)) walk(c, depth + 1);
      };
      for (const r of snapshot.all.children) walk(r, 0);
      return out;
    };

    function paint() {
      const frag = document.createDocumentFragment();
      for (const [n, depth] of visibleRows()) {
        const k = nodeKey(n);
        const row = el('div', `pf-row pf-item${treeSelected && nodeKey(treeSelected) === k ? ' selected' : ''}`);
        row.dataset.key = k;
        row.dataset.depth = depth;
        const name = nameCell(n.fn);
        name.style.paddingLeft = `${depth * 16 + 4}px`;
        const leaf = !childrenOf(n).length;
        const arrow = el('span', 'pf-arrow', leaf ? '' : expanded.has(k) ? '▾' : '▸');
        arrow.onclick = (e) => { e.stopPropagation(); toggle(n); };
        name.prepend(arrow);
        row.append(name, el('span', 'pf-num', String(n.calls)), timeCell(n.time, true), timeCell(ownOf(n), false));
        row.onclick = () => { treeSelected = n; markSelected(rows, row); };
        row.ondblclick = () => navigate(n.fn);
        row.oncontextmenu = (e) => { e.preventDefault(); treeSelected = n; paint(); fnMenu(n.fn, e.clientX, e.clientY); };
        frag.appendChild(row);
      }
      rows.replaceChildren(frag);
    }

    function toggle(n) {
      const k = nodeKey(n);
      if (expanded.has(k)) expanded.delete(k); else expanded.add(k);
      paint();
    }

    rows.onkeydown = (e) => {
      const list = visibleRows();
      const i = list.findIndex(([n]) => treeSelected && nodeKey(n) === nodeKey(treeSelected));
      const n = treeSelected;
      if (e.key === 'ArrowDown' || e.key === 'ArrowUp') {
        e.preventDefault();
        treeSelected = list[Math.max(0, Math.min(list.length - 1, i + (e.key === 'ArrowDown' ? 1 : -1)))]?.[0] || null;
        paint();
        rows.querySelector('.selected')?.scrollIntoView({ block: 'nearest' });
      } else if (e.key === 'ArrowRight' && n && !expanded.has(nodeKey(n))) toggle(n);
      else if (e.key === 'ArrowLeft' && n && expanded.has(nodeKey(n))) toggle(n);
      else if (e.key === 'ArrowLeft' && n?.parent?.fn) { treeSelected = n.parent; paint(); }
      else if ((e.key === 'Enter' || e.key === 'F4') && n) {
        e.preventDefault();
        e.stopPropagation();
        navigate(n.fn);
      }
    };
    return { root, render: paint };
  }

  function revealInTree(fn) {
    const node = findNode(fn);
    if (!node) return;
    for (let p = node.parent; p?.fn; p = p.parent) expanded.add(nodeKey(p));
    treeSelected = node;
    showTab('tree');
    panes.tree.root.querySelector('.pf-item.selected')?.scrollIntoView({ block: 'center' });
  }

  // ---------- Flame Graph ----------
  let zoom = null; // the node drawn full width, or null for all
  const ROW = 20;
  let clickTimer = null;
  const MAX_DEPTH = 64;

  // Project code warm orange, other Python code yellow, built-ins gray-blue; lightness varies by name.
  function color(fn) {
    if (!fn) return 'hsl(0, 0%, 62%)';
    let h = 0;
    for (const ch of fn.name) h = (h * 31 + ch.charCodeAt(0)) >>> 0;
    const l = 58 + (h % 14);
    if (!navigable(fn)) return `hsl(205, 32%, ${l}%)`;
    return ide.root && isUnder(fn.file, ide.root) ? `hsl(${18 + (h % 18)}, 78%, ${l}%)` : `hsl(${44 + (h % 12)}, 75%, ${l}%)`;
  }

  function buildFlame() {
    const root = el('div', 'pf-pane pf-flame');
    const bar = el('div', 'pf-flame-bar');
    const reset = el('button', 'secondary pf-reset', tr('Reset Zoom'));
    reset.onclick = () => { zoom = null; paint(); };
    const hint = el('span', 'muted pf-flame-hint', tr('Click a frame to zoom in, double-click to navigate to source.'));
    bar.append(reset, hint);
    const canvas = el('div', 'pf-flame-canvas');
    root.append(bar, canvas);

    function paint() {
      if (!snapshot || root.classList.contains('hidden')) return;
      reset.classList.toggle('hidden', !zoom);
      const width = canvas.clientWidth || 800;
      const base = zoom || snapshot.all;
      // Ancestors of a zoomed frame stay below it, full width.
      const chain = [];
      for (let p = base; p; p = p.parent) chain.unshift(p);
      const frames = [];
      chain.forEach((n, depth) => frames.push({ n, x: 0, w: width, depth, ancestor: n !== base }));
      const scale = base.time > 0 ? width / base.time : 0;
      let maxDepth = chain.length - 1;
      const walk = (n, x, depth) => {
        if (depth > MAX_DEPTH) return;
        let cx = x;
        for (const c of childrenOf(n)) {
          const w = c.time * scale;
          if (w < 1) break; // sorted by time, so the rest is narrower still
          frames.push({ n: c, x: cx, w, depth });
          maxDepth = Math.max(maxDepth, depth);
          walk(c, cx, depth + 1);
          cx += w;
        }
      };
      walk(base, 0, chain.length);
      canvas.style.height = `${(maxDepth + 1) * ROW}px`;
      const frag = document.createDocumentFragment();
      for (const { n, x, w, depth, ancestor } of frames) {
        const f = el('div', `pf-frame${ancestor ? ' ancestor' : ''}${n === base && zoom ? ' zoomed' : ''}`);
        f.style.cssText = `left:${x}px;width:${Math.max(1, w - 1)}px;bottom:${depth * ROW}px;background:${color(n.fn)}`;
        f.dataset.key = nodeKey(n);
        if (n.fn) f.dataset.name = n.fn.name;
        if (w > 30) { const t = el('span', 'pf-frame-text', n.fn ? n.fn.name : tr('All calls')); if (n.fn) t.dataset.userText = ''; f.appendChild(t); }
        f.title = [n.fn ? n.fn.name : tr('All calls'), location(n.fn),
          tr('Total: {time} ms ({percent})', { time: ms(n.time), percent: share(n.time) }),
          tr('Own: {time} ms', { time: ms(ownOf(n)) }),
          n.fn ? tr('Calls: {count}', { count: n.calls }) : ''].filter(Boolean).join('\n');
        // Zooming waits out a possible double-click, which navigates instead.
        f.onclick = () => { clearTimeout(clickTimer); clickTimer = setTimeout(() => { zoom = n.fn ? n : null; paint(); }, 250); };
        f.ondblclick = () => { clearTimeout(clickTimer); navigate(n.fn); };
        f.oncontextmenu = (e) => { e.preventDefault(); if (n.fn) fnMenu(n.fn, e.clientX, e.clientY); };
        frag.appendChild(f);
      }
      canvas.replaceChildren(frag);
      // The base sits at the bottom; deep, narrow stacks grow upwards out of view.
      root.scrollTop = root.scrollHeight;
    }
    return { root, render: paint };
  }

  function revealInFlame(fn) {
    const node = findNode(fn);
    zoom = node || null;
    showTab('flame');
  }

  // ---------- actions ----------
  ide.registerAction({ id: 'Profile', title: tr('Profile'), run: () => run.runSelected({ executor: 'Profile' }) });
  ide.on('projectOpened', () => { snapshot = null; render(); });

  ide.profiler = {
    snapshot: () => snapshot && { name: snapshot.name, time: snapshot.time.getTime(), total: snapshot.total, functions: snapshot.fns.map(({ callees, ...f }) => f) },
    showTab,
  };
})();
