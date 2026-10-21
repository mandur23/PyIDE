// Search Everywhere (Double Shift): one popup over Go to Class, Go to File, Go to Symbol, Find Action and the
// settings pages, with PyCharm's tabs (All / Classes / Files / Symbols / Actions / Settings).
(() => {
  const { el, basename, dirname, rel, samePath } = ide.util;
  const nav = ide.searchNav;
  const GROUP_LIMIT = 5; // rows per group on the All tab before "more"
  const TAB_LIMIT = 100; // rows on a single tab
  const CHUNK = 4000; // items matched between yields, so typing stays smooth on a 20,000-file project
  const userText = (node) => { node.dataset.userText = ''; return node; };
  const tick = () => new Promise((r) => setTimeout(r));
  const keyHint = (keys) => keys.map((k) => (k === 'Shift Shift' ? tr('Double Shift') : k)).join(', ');

  // A plain subsequence ("mdl" -> models) only counts from three characters on; shorter ones match nearly anything.
  const score = (text, q) => {
    const m = nav.match(text, q, { fuzzy: true });
    return m.score === 10 && q.replace(/\s/g, '').length < 3 ? { score: 0, ranges: [] } : m;
  };

  function highlight(text, ranges) {
    const frag = document.createDocumentFragment();
    let last = 0;
    for (const [s, e] of ranges) {
      if (s < last || e <= s) continue;
      frag.append(text.slice(last, s), el('span', 'sn-hit', text.slice(s, e)));
      last = e;
    }
    frag.append(text.slice(last));
    return frag;
  }

  const topBy = (scored, limit) => scored.sort((a, b) => b.score - a.score || a.tie - b.tie).slice(0, limit);

  // ---------- contributors: (query, ctx) -> [{key, label, ranges, detail, hint, icon, run, user}] or null when stale ----------
  async function files(q, ctx) {
    if (!ide.root) return [];
    if (!q) {
      const recent = nav.recentFiles().filter((p) => !samePath(p, ide.active));
      const exists = await Promise.all(recent.map((p) => ide.api.exists(p)));
      ctx.title = tr('Recent Files');
      return recent.filter((_, i) => exists[i]).slice(0, ctx.limit).map((p) => fileItem(p, { score: 1, ranges: [] }));
    }
    // "models.py:12" or "models.py:12:5" opens at that line, as in PyCharm.
    const pos = /^(.*?):(\d+)(?::(\d+))?$/.exec(q);
    const name = pos ? pos[1] : q;
    if (!name) return [];
    const byPath = /[\\/]/.test(name);
    const needle = byPath ? name.replace(/\\/g, '/') : name;
    const recent = new Set(nav.recentFiles().map((p) => p.toLowerCase()));
    const list = await ctx.files();
    const scored = [];
    for (let i = 0; i < list.length; i++) {
      if (i % CHUNK === CHUNK - 1) { await tick(); if (ctx.stale()) return null; }
      const p = list[i];
      const text = byPath ? rel(p).replace(/\\/g, '/') : basename(p);
      const m = score(text, needle);
      if (m.score) scored.push({ p, m, score: m.score + (recent.has(p.toLowerCase()) ? 5 : 0), tie: p.length });
    }
    return topBy(scored, ctx.limit).map(({ p, m }) => fileItem(p, byPath ? { ...m, ranges: [] } : m, pos && { line: +pos[2], col: +(pos[3] || 1) }));
  }

  function fileItem(p, m, at) {
    return {
      key: `file:${p}`, label: basename(p), ranges: m.ranges, detail: rel(dirname(p)) || basename(ide.root), icon: ide.fileIcon(p), user: true,
      run: () => (at ? nav.goTo(p, at.line, at.col) : ide.openFile(p)),
    };
  }

  async function symbols(q, ctx, kind) {
    if (!q || !ide.root) return [];
    const all = await ctx.symbols();
    if (ctx.stale()) return null;
    const list = ctx.cache[kind] ||= all.filter(kind === 'classes' ? (s) => s.kind === 'class' : kind === 'others' ? (s) => s.kind !== 'class' : () => true);
    const name = q.slice(q.lastIndexOf('.') + 1);
    return nav.rankSymbols(list, q, ctx.limit).map(({ value: s, detail, hint }) => ({
      key: `sym:${s.path}:${s.line}:${s.name}`, label: s.name, ranges: nav.match(s.name, name).ranges, detail, hint,
      icon: nav.kindIcon(s.kind), user: true, run: () => nav.goTo(s.path, s.line, s.col, s.name.length),
    }));
  }

  function actions(q, ctx) {
    if (!q) return [];
    const scored = [];
    for (const a of ide.actions) {
      if (!a.title || a.id === 'SearchEverywhere') continue;
      const m = score(a.title, q);
      if (m.score) scored.push({ a, m, score: m.score, tie: a.title.length });
    }
    return topBy(scored, ctx.limit).map(({ a, m }) => ({
      key: `action:${a.id}`, label: a.title, ranges: m.ranges, hint: keyHint(a.keys), run: () => ide.runAction(a.id),
    }));
  }

  function settings(q, ctx) {
    if (!ide.openSettings || !ide.settingsPageList) return [];
    const pages = ide.settingsPageList();
    const item = (p, m, detail) => ({
      key: `settings:${p.id}`, label: p.title, ranges: m.ranges, detail, icon: ide.icon('settings', '⚙'), run: () => ide.openSettings(p.id),
    });
    if (!q) return ctx.tab === 'settings' ? pages.map((p) => item(p, { ranges: [] }, p.group)) : [];
    const words = q.toLowerCase().split(/\s+/).filter(Boolean);
    const scored = [];
    for (const p of pages) {
      const m = score(p.title, q);
      // Keywords ("shortcut" finds Keymap) rank below title matches and are shown next to the page.
      const kw = !m.score && p.keywords.toLowerCase().split(/\s+/).filter((k) => words.some((w) => k.includes(w)));
      if (m.score) scored.push({ p, m, score: m.score, tie: 0, detail: p.group });
      else if (kw?.length && words.every((w) => kw.some((k) => k.includes(w)))) scored.push({ p, m: { ranges: [] }, score: 20, tie: 0, detail: [p.group, kw.join(', ')].filter(Boolean).join(' · ') });
    }
    return topBy(scored, ctx.limit).map(({ p, m, detail }) => item(p, m, detail));
  }

  const CONTRIBUTORS = [
    { id: 'classes', title: () => tr('Classes'), search: (q, ctx) => symbols(q, ctx, 'classes') },
    { id: 'files', title: () => tr('Files'), search: files },
    // On All, classes are already listed above, so the Symbols group leaves them out.
    { id: 'symbols', title: () => tr('Symbols'), search: (q, ctx) => symbols(q, ctx, ctx.tab === 'all' ? 'others' : 'all') },
    { id: 'actions', title: () => tr('Actions'), search: actions },
    { id: 'settings', title: () => tr('Settings'), search: settings },
  ];
  const TABS = [{ id: 'all', title: () => tr('All') }, ...CONTRIBUTORS];

  // ---------- popup ----------
  let state = null; // the open popup
  let lastQuery = '';

  function open({ tab: startTab = 'all', query } = {}) {
    if (state) { state.setTab(startTab); return; }
    const prevFocus = document.activeElement;
    const backdrop = el('div', 'se-backdrop');
    const box = el('div', 'se-popup');
    box.id = 'searchEverywhere';
    const tabs = el('div', 'se-tabs');
    const input = el('input', 'se-input');
    input.id = 'seInput';
    input.spellcheck = false;
    input.placeholder = tr('Type to search everywhere');
    const inputWrap = el('div', 'se-input-wrap');
    inputWrap.append(ide.icon('search', '⌕'), input);
    const list = el('div', 'se-list');
    list.id = 'seList';
    box.append(tabs, inputWrap, list);
    backdrop.append(box);
    // Living in #dialogHost suspends the global keymap while the popup is open.
    document.getElementById('dialogHost').appendChild(backdrop);

    // Loaded once per popup: the project walk (on main's worker) and the symbol index Go to Symbol uses.
    let filesP = null;
    let symbolsP = null;
    const session = {
      // Scratch files (scratches plugin) are found too, as in PyCharm, though they are outside the project.
      files: () => (filesP ||= Promise.all([ide.api.walk(ide.root), ide.scratches?.list() ?? []]).then(([a, b]) => [...a, ...b])),
      symbols: () => (symbolsP ||= nav.symbols()),
      cache: {},
    };

    let tab = TABS.some((t) => t.id === startTab) ? startTab : 'all';
    let gen = 0;
    let timer = null;
    let rows = [];
    let activeKey = null;
    let enterGen = 0; // an Enter waiting for the search of the text typed just before it

    for (const t of TABS) {
      const b = el('button', 'se-tab', t.title());
      b.dataset.tab = t.id;
      b.onmousedown = (e) => { e.preventDefault(); setTab(t.id); };
      tabs.append(b);
    }

    // Each popup closes only itself: a closed popup's late blur timer must not close the next one.
    function close() {
      if (state !== me) return;
      state = null;
      gen++;
      clearTimeout(timer);
      lastQuery = input.value;
      backdrop.remove();
      if (prevFocus?.isConnected) prevFocus.focus();
    }

    function choose(row) {
      const it = row?._item;
      if (!it) return;
      if (it.more) return setTab(it.more);
      close();
      it.run();
    }

    function setActive(row) {
      for (const r of rows) r.classList.toggle('active', r === row);
      activeKey = row?._item.key ?? null;
      row?.scrollIntoView({ block: 'nearest' });
    }

    function setTab(id) {
      tab = id;
      for (const b of tabs.children) b.classList.toggle('active', b.dataset.tab === id);
      activeKey = null;
      list.scrollTop = 0;
      search();
    }

    function rowOf(it) {
      const row = el('div', `se-row${it.more ? ' se-more' : ''}`);
      row._item = it;
      if (it.more) row.append(el('span', 'se-label', tr('more')));
      else {
        const icon = el('span', 'se-icon');
        if (it.icon) icon.append(it.icon);
        const label = el('span', 'se-label');
        label.append(highlight(it.label, it.ranges || []));
        row.append(icon, it.user ? userText(label) : label);
        if (it.detail) row.append(userText(el('span', 'se-detail', it.detail)));
        if (it.hint) row.append(el('span', 'se-hint', it.hint));
      }
      row.dataset.key = it.key;
      row.onmousedown = (e) => { e.preventDefault(); choose(row); };
      row.onmousemove = () => !row.classList.contains('active') && setActive(row);
      return row;
    }

    // Groups render as their contributors answer, in a fixed order, so slow symbol indexing never holds back files.
    function render(results, pending) {
      const nodes = [];
      for (const c of CONTRIBUTORS) {
        const r = results.get(c.id);
        if (!r?.items.length) continue;
        if (tab === 'all') {
          const head = el('div', 'se-group', r.title || c.title());
          head.dataset.group = c.id;
          nodes.push(head);
        }
        const shown = tab === 'all' ? r.items.slice(0, GROUP_LIMIT) : r.items;
        nodes.push(...shown.map(rowOf));
        if (tab === 'all' && r.items.length > GROUP_LIMIT) nodes.push(rowOf({ key: `more:${c.id}`, more: c.id }));
      }
      if (!nodes.length) nodes.push(el('div', 'se-empty', pending ? tr('Searching…') : input.value.trim() ? tr('Nothing found') : tr('Type to search everywhere')));
      list.replaceChildren(...nodes);
      rows = [...list.querySelectorAll('.se-row')];
      setActive(rows.find((r) => r._item.key === activeKey) || rows[0]);
      if (enterGen === gen && !pending) { enterGen = 0; choose(rows.find((r) => r.classList.contains('active'))); }
    }

    function search() {
      const my = ++gen;
      const q = input.value.trim();
      const stale = () => my !== gen;
      const results = new Map();
      const wanted = tab === 'all' ? CONTRIBUTORS : CONTRIBUTORS.filter((c) => c.id === tab);
      let pending = wanted.length;
      for (const c of wanted) {
        const ctx = { ...session, tab, limit: tab === 'all' ? GROUP_LIMIT + 1 : TAB_LIMIT, stale };
        Promise.resolve().then(() => c.search(q, ctx)).then((items) => {
          if (stale() || !items) return;
          results.set(c.id, { items, title: ctx.title });
          render(results, --pending > 0);
        }, (err) => {
          ide.log.warn(`Search Everywhere: ${c.id} failed: ${err?.message || err}`);
          if (!stale()) render(results, --pending > 0);
        });
      }
      if (pending) render(results, true);
    }

    input.oninput = () => {
      gen++; // drops answers to the previous text at once
      activeKey = null;
      clearTimeout(timer);
      timer = setTimeout(() => { timer = null; search(); }, 120);
    };
    input.onkeydown = (e) => {
      if (e.key === 'Escape') { e.preventDefault(); e.stopPropagation(); close(); return; }
      if (e.key === 'Tab') {
        e.preventDefault();
        const i = TABS.findIndex((t) => t.id === tab);
        setTab(TABS[(i + (e.shiftKey ? -1 : 1) + TABS.length) % TABS.length].id);
      } else if (e.key === 'ArrowDown' || e.key === 'ArrowUp') {
        e.preventDefault();
        if (!rows.length) return;
        const i = rows.findIndex((r) => r.classList.contains('active'));
        setActive(rows[(i + (e.key === 'ArrowDown' ? 1 : -1) + rows.length) % rows.length]);
      } else if (e.key === 'Enter') {
        e.preventDefault();
        // An Enter typed before the debounced search ran applies to the current text, not to the rows still shown.
        if (timer) { clearTimeout(timer); timer = null; search(); enterGen = gen; return; }
        choose(rows.find((r) => r.classList.contains('active')));
      }
    };
    backdrop.onmousedown = (e) => { if (e.target === backdrop) close(); };
    input.onblur = () => setTimeout(() => !box.contains(document.activeElement) && close(), 120);

    const me = { close, setTab };
    state = me;
    input.value = query ?? lastQuery;
    input.focus();
    input.select();
    setTab(tab);
  }

  ide.registerAction({ id: 'SearchEverywhere', title: tr('Search Everywhere'), keys: 'Shift Shift', run: () => open() });
  ide.searchEverywhere = { open, close: () => state?.close(), isOpen: () => !!state };
})();
