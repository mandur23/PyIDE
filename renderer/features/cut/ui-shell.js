// The editor's frame (docs/cut-architecture.md section 10): the menu bar (ui-menubar.js) and the top bar, the
// workspaces (Premiere Pro's panel layouts the top tabs switch between: Editing, Color, Effects, Audio, Captions and
// Graphics, plus Export), saving and resetting a workspace's layout, maximizing one frame, and the project's life: an
// untitled project at start, New, Open, Save, Save As, Save a Copy, an autosave
// of the latest state 2 s after edits stop and a copy every few minutes (settings cut.autosave.minutes and
// cut.autosave.keep), the recovery offer after a crash, and the question about unsaved changes before the project or
// the window closes.
//
// Panels are mounted once, the first time a workspace shows them, and moved between workspaces after that, so a
// monitor keeps its player and a list its scroll position. The panel with the keyboard (app.focusPanel) is the one
// last clicked or focused; ui-keys.js sends keys to it.
(() => {
  const Cut = (globalThis.Cut = globalThis.Cut || {});
  const ui = Cut.ui;
  const { el, icon, button } = ui;
  const log = ide.logger('#cut');

  const AUTOSAVE_MS = 2000;
  // The interval copies (video-editor-features.md section 17): every `cut.autosave.minutes`, while the project has
  // changes the last copy does not have; the newest `cut.autosave.keep` are kept.
  const COPY_MINUTES = 5;
  const COPY_KEEP = 20;
  const copyMinutes = () => { const v = Number(ide.settings.get('cut.autosave.minutes', COPY_MINUTES)); return Number.isFinite(v) && v >= 1 ? Math.min(120, v) : COPY_MINUTES; };
  const copyKeep = () => { const v = Math.round(Number(ide.settings.get('cut.autosave.keep', COPY_KEEP))); return Number.isFinite(v) && v >= 1 ? Math.min(100, v) : COPY_KEEP; };
  const FILTERS = () => [{ name: tr('Nano Studio Cut project'), extensions: ['ncut'] }];

  // rows top to bottom, slots left to right; sizes are percentages. A slot shows its panels as tabs; a panel that is
  // not registered (the audio mixer and the color scopes until their files load) is left out of its slot.
  // A slot with `dock: true` takes the panels the Window menu adds to its workspace. `min` is a smaller least width (px). A `fixed` slot is that many pixels
  // wide with no tabs (the Tools panel between the project panel and the timeline, as in Premiere Pro); the splitter
  // beside it moves the space between its two other neighbours.
  const TOOLS_SLOT = { panels: ['tools'], fixed: 36 };
  // Panels other files bring (the color scopes, the audio mixer, Essential Sound): their slots wait for them.
  const OPTIONAL = new Set(['scopes', 'mixer', 'essential']);
  const WORKSPACES = [
    // Premiere's Editing: Source and Effect Controls over the Project panel and its tabs, the Program monitor over the
    // timeline, the Tools panel between them and the audio meters at the right of the timeline.
    { id: 'editing', title: () => tr('Editing'), rows: [
      { size: 54, slots: [{ size: 45, panels: ['source', 'controls'] }, { size: 55, panels: ['program'] }] },
      { size: 46, slots: [{ size: 28, panels: ['project', 'effects', 'markers', 'history', 'transcript'], dock: true }, TOOLS_SLOT, { size: 66, panels: ['timeline'] }, { size: 6, panels: ['meters'], min: 56 }] },
    ] },
    { id: 'color', title: () => tr('Color'), rows: [
      { size: 60, slots: [{ size: 28, panels: ['scopes', 'source'] }, { size: 44, panels: ['program'] }, { size: 28, panels: ['color', 'controls'] }] },
      { size: 40, slots: [{ size: 24, panels: ['project', 'effects', 'history'], dock: true }, TOOLS_SLOT, { size: 70, panels: ['timeline'] }, { size: 6, panels: ['meters'], min: 56 }] },
    ] },
    { id: 'effects', title: () => tr('Effects'), rows: [
      { size: 56, slots: [{ size: 30, panels: ['controls', 'source'] }, { size: 46, panels: ['program'] }, { size: 24, panels: ['effects', 'markers'] }] },
      { size: 44, slots: [{ size: 24, panels: ['project', 'history'], dock: true }, TOOLS_SLOT, { size: 70, panels: ['timeline'] }, { size: 6, panels: ['meters'], min: 56 }] },
    ] },
    // Premiere's Audio: the Audio Track Mixer (panel 'mixer') top left, the program monitor, Essential Sound at the right.
    { id: 'audio', title: () => tr('Audio'), rows: [
      { size: 56, slots: [{ size: 38, panels: ['mixer', 'controls', 'source'] }, { size: 42, panels: ['program'] }, { size: 20, panels: ['essential'] }] },
      { size: 44, slots: [{ size: 24, panels: ['project', 'effects', 'markers', 'history', 'transcript'], dock: true }, TOOLS_SLOT, { size: 66, panels: ['timeline'] }, { size: 10, panels: ['meters'], min: 56 }] },
    ] },
    { id: 'captions', title: () => tr('Captions and Graphics'), rows: [
      { size: 58, slots: [{ size: 30, panels: ['captions', 'transcript', 'markers'] }, { size: 44, panels: ['program'] }, { size: 26, panels: ['text', 'controls'] }] },
      { size: 42, slots: [{ size: 26, panels: ['project', 'effects', 'history'], dock: true }, TOOLS_SLOT, { size: 74, panels: ['timeline'] }] },
    ] },
    { id: 'export', title: () => tr('Export'), rows: [
      { size: 62, slots: [{ size: 36, panels: ['export', 'queue', 'markers'], dock: true }, { size: 57, panels: ['program'] }, { size: 7, panels: ['meters'] }] },
      { size: 38, slots: [{ size: 100, panels: ['timeline'] }] },
    ] },
  ];
  // The Window menu's order.
  const PANEL_ORDER = ['project', 'source', 'program', 'timeline', 'tools', 'controls', 'effects', 'mixer', 'essential', 'color', 'scopes', 'text', 'captions', 'transcript', 'markers', 'history', 'meters', 'export', 'queue', 'assistant'];

  let app = null;
  let root = null;
  let stage = null; // where the workspace grid goes
  let shelf = null; // panels not shown in the current workspace wait here
  let current = null; // workspace id
  const mounted = new Map(); // panel id -> {host, body, dispose, focus}
  const activeTab = new Map(); // `${workspace}:${slot index}` -> panel id
  // Panels that live in the AI dock (a full-height column right of every workspace), never in a workspace's slots.
  const DOCKED = new Set(['assistant']);
  let dock = null;
  let dockBody = null;
  let dockSplit = null;
  let aiBtn = null;

  // ---------- panels ----------
  function panelHost(id) {
    if (mounted.has(id)) return mounted.get(id);
    const def = ui.panels.get(id);
    const host = el('section', 'cut-panel', undefined, { 'data-panel': id, tabindex: -1 });
    const body = el('div', 'cut-panel-body');
    host.appendChild(body);
    const entry = { host, body, dispose: null, focus: null, def };
    mounted.set(id, entry);
    if (!def) {
      body.appendChild(el('div', 'cut-empty', tr('This panel is not available.')));
      return entry;
    }
    try {
      const r = def.mount(body, app);
      if (typeof r === 'function') entry.dispose = r;
      else if (r && typeof r === 'object') { entry.dispose = r.dispose || null; entry.focus = r.focus || null; }
    } catch (err) {
      log.error(`panel ${id} did not mount: ${err?.stack || err}`);
      body.replaceChildren(el('div', 'cut-empty', tr('This panel could not start.')));
    }
    return entry;
  }
  const panelTitle = (id) => {
    const def = ui.panels.get(id);
    try { return def?.title?.() || id; } catch { return id; }
  };

  // ---------- workspaces ----------
  const sizesKey = (id) => `cut.layout.${id}`;
  const savedSizes = (ws) => {
    const s = ide.settings.get(sizesKey(ws.id), null);
    const ok = s && Array.isArray(s.rows) && s.rows.length === ws.rows.length && Array.isArray(s.slots) && s.slots.length === ws.rows.length
      && s.slots.every((r, i) => Array.isArray(r) && r.length === ws.rows[i].slots.length);
    return ok ? s : { rows: ws.rows.map((r) => r.size), slots: ws.rows.map((r) => r.slots.map((x) => x.size)) };
  };

  function setWorkspace(id) {
    const ws = WORKSPACES.find((w) => w.id === id) || WORKSPACES[0];
    current = ws.id;
    ide.settings.set('cut.workspace', ws.id);
    for (const t of root.querySelectorAll('.cut-ws-tab')) t.setAttribute('aria-selected', String(t.dataset.ws === ws.id));
    for (const [id, { host }] of mounted) if (!(DOCKED.has(id) && dockOpen())) shelf.appendChild(host);
    const sizes = savedSizes(ws);
    const grid = el('div', 'cut-grid', undefined, { 'data-workspace': ws.id });
    ws.rows.forEach((rowDef, ri) => {
      if (ri) grid.appendChild(splitter('h', grid, ws, ri));
      const rowEl = el('div', 'cut-row');
      rowEl.style.flexGrow = String(sizes.rows[ri]);
      rowDef.slots.forEach((slotDef, si) => {
        // No splitter right after a fixed slot: the one before it moves the space around it.
        if (si && !rowDef.slots[si - 1].fixed) rowEl.appendChild(splitter('v', rowEl, ws, ri, si));
        rowEl.appendChild(slot(ws, ri, si, slotDef, sizes.slots[ri][si]));
      });
      for (const bar of rowEl.querySelectorAll(':scope > .cut-splitter')) if (bar.nextElementSibling?.hidden) bar.hidden = true;
      grid.appendChild(rowEl);
    });
    stage.replaceChildren(grid);
    root.dataset.workspace = ws.id;
    for (const t of root.querySelectorAll('.cut-ws-tab')) t.hidden = false;
    fitTabs();
    app.emit('workspace', { id: ws.id });
    // The keyboard stays with its panel when that panel is still on screen; otherwise the main one of this workspace.
    if (!grid.querySelector(`.cut-panel[data-panel="${app.focusPanel}"]`)) {
      const first = ['timeline', 'program'].find((p) => grid.querySelector(`.cut-panel[data-panel="${p}"]`));
      if (first) app.setFocus(first);
    }
    markFocus();
  }

  function slot(ws, ri, si, def, size) {
    const s = el('div', `cut-slot${def.fixed ? ' fixed' : ''}`);
    if (def.fixed) s.style.flex = `0 0 ${def.fixed}px`;
    else s.style.flexGrow = String(size);
    // a narrow panel (the audio meters beside the timeline, as in Premiere) may go below the usual 80 px
    if (def.min) s.style.minWidth = `${def.min}px`;
    const added = addedPanels(ws).filter((x) => x.slot === `${ri}:${si}`).map((x) => x.panel);
    const available = [...def.panels, ...added].filter((p) => ui.panels.has(p));
    // A slot kept for panels that are not there (the mixer before its file loads) stays out of sight.
    if (!available.length && def.panels.every((p) => OPTIONAL.has(p))) {
      s.hidden = true;
      return s;
    }
    const list = available.length ? available : def.panels.slice(0, 1);
    const tabs = el('div', 'cut-slot-tabs', undefined, { role: 'tablist' });
    const body = el('div', 'cut-slot-body');
    const key = `${ws.id}:${ri}:${si}`;
    let active = list.includes(activeTab.get(key)) ? activeTab.get(key) : list[0];
    const show = (id, { focus = false } = {}) => {
      active = id;
      activeTab.set(key, id);
      for (const t of tabs.children) t.setAttribute('aria-selected', String(t.dataset.panel === id));
      const entry = panelHost(id);
      for (const n of [...body.children]) if (n !== entry.host) shelf.appendChild(n);
      if (entry.host.parentNode !== body) body.appendChild(entry.host);
      if (focus) focusPanel(id);
    };
    for (const id of list) {
      // The label shortens with an ellipsis when the slot is narrow, so every tab (and an added tab's close mark) stays on screen.
      const t = el('button', 'cut-slot-tab', undefined, { 'data-panel': id, role: 'tab', type: 'button', title: panelTitle(id) });
      t.appendChild(el('span', 'cut-slot-tab-label', panelTitle(id)));
      t.addEventListener('mousedown', (e) => { if (e.button === 0) e.preventDefault(); });
      t.addEventListener('click', () => show(id, { focus: true }));
      // A panel the Window menu added has a close mark that takes it out of this workspace again.
      if (added.includes(id)) {
        t.classList.add('added');
        const x = el('span', 'cut-slot-tab-close', '×', { title: tr('Close'), 'aria-label': tr('Close'), role: 'button' });
        x.addEventListener('mousedown', (e) => { e.preventDefault(); e.stopPropagation(); });
        x.addEventListener('click', (e) => { e.stopPropagation(); closeAdded(id); });
        t.appendChild(x);
      }
      tabs.appendChild(t);
    }
    s.append(tabs, body);
    show(active);
    return s;
  }

  // Dragging a splitter moves the space between its two neighbours; the result is kept per workspace.
  function splitter(dir, parent, ws, ri, si) {
    const bar = el('div', `cut-splitter ${dir}`);
    bar.addEventListener('pointerdown', (e) => {
      if (e.button !== 0) return;
      e.preventDefault();
      bar.setPointerCapture(e.pointerId);
      // the nearest resizable neighbours (a fixed slot keeps its width)
      const near = (dirn) => {
        let x = bar;
        do x = dirn < 0 ? x.previousElementSibling : x.nextElementSibling;
        while (x && (x.classList.contains('cut-splitter') || x.classList.contains('fixed') || x.hidden));
        return x;
      };
      const a = near(-1);
      const b = near(1);
      if (!a || !b) return;
      const ra = a.getBoundingClientRect();
      const rb = b.getBoundingClientRect();
      const ga = Number(a.style.flexGrow) || 1;
      const gb = Number(b.style.flexGrow) || 1;
      const total = dir === 'v' ? ra.width + rb.width : ra.height + rb.height;
      const start = dir === 'v' ? e.clientX : e.clientY;
      const first = dir === 'v' ? ra.width : ra.height;
      const move = (m) => {
        const d = (dir === 'v' ? m.clientX : m.clientY) - start;
        const fa = Math.min(total - 80, Math.max(80, first + d)) / total;
        a.style.flexGrow = String((ga + gb) * fa);
        b.style.flexGrow = String((ga + gb) * (1 - fa));
      };
      const up = () => {
        bar.removeEventListener('pointermove', move);
        bar.removeEventListener('pointerup', up);
        ide.settings.set(sizesKey(ws.id), currentSizes());
      };
      bar.addEventListener('pointermove', move);
      bar.addEventListener('pointerup', up);
    });
    return bar;
  }

  // The splitters' places in the workspace on screen (what `cut.layout.<id>` keeps).
  function currentSizes() {
    const rows = [...stage.querySelectorAll('.cut-grid > .cut-row')];
    return {
      rows: rows.map((r) => Number(r.style.flexGrow) || 1),
      slots: rows.map((r) => [...r.querySelectorAll(':scope > .cut-slot')].map((x) => Number(x.style.flexGrow) || 1)),
    };
  }

  // ---------- saved layouts ----------
  // Save Changes to This Workspace keeps its splitters and the panels the Window menu added (`cut.layoutSaved`);
  // Reset to Saved Layout ("이 작업 영역 재설정", Alt+Shift+0) brings that back, or the built-in layout when none was saved.
  const SAVED_KEY = 'cut.layoutSaved';
  const savedLayouts = () => { const v = ide.settings.get(SAVED_KEY, null); return v && typeof v === 'object' && !Array.isArray(v) ? v : {}; };
  function saveWorkspace(id = current) {
    const ws = WORKSPACES.find((w) => w.id === id);
    if (!ws) return false;
    const sizes = id === current ? currentSizes() : savedSizes(ws);
    ide.settings.set(SAVED_KEY, { ...savedLayouts(), [id]: { sizes, added: addedPanels(ws) } });
    ui.toast(tr('Saved the {name} workspace', { name: ws.title() }));
    return true;
  }
  function resetWorkspace(id = current) {
    const ws = WORKSPACES.find((w) => w.id === id);
    if (!ws) return false;
    const saved = savedLayouts()[id];
    ide.settings.set(sizesKey(id), saved?.sizes || null);
    saveAdded(id, Array.isArray(saved?.added) ? saved.added : []);
    for (const k of [...activeTab.keys()]) if (k.startsWith(`${id}:`)) activeTab.delete(k);
    setWorkspace(id);
    return true;
  }

  // ---------- maximize a frame (` and Shift+`) ----------
  // One slot fills the workspace until the key comes again (or another workspace shows). underCursor: the slot under
  // the pointer, else the one whose panel has the keyboard.
  let pointer = null;
  function toggleMaximize({ underCursor = false } = {}) {
    const grid = stage.querySelector('.cut-grid');
    if (!grid) return false;
    if (grid.classList.contains('maximized')) {
      grid.classList.remove('maximized');
      for (const s of grid.querySelectorAll('.cut-slot.max')) s.classList.remove('max');
      return false;
    }
    const hit = underCursor && pointer ? document.elementFromPoint(pointer.x, pointer.y)?.closest?.('.cut-grid .cut-slot') : null;
    const s = hit || mounted.get(app.focusPanel)?.host.closest('.cut-slot');
    if (!s || !grid.contains(s) || s.classList.contains('fixed')) return false;
    s.classList.add('max');
    grid.classList.add('maximized');
    return true;
  }

  function focusPanel(id) {
    const entry = mounted.get(id);
    if (!entry || !entry.host.isConnected) return false;
    app.setFocus(id);
    if (entry.focus) entry.focus();
    else if (!entry.host.contains(document.activeElement)) entry.host.focus({ preventScroll: true });
    return true;
  }
  // Shows a panel (switching its slot's tab, or to the first workspace that has it) and gives it the keyboard.
  function showPanel(id) {
    if (DOCKED.has(id)) return setDock(true);
    const tab = root.querySelector(`.cut-grid .cut-slot-tab[data-panel="${id}"]`);
    if (!tab) {
      const ws = WORKSPACES.find((w) => w.rows.some((r) => r.slots.some((s) => s.panels.includes(id))));
      if (!ws) return false;
      setWorkspace(ws.id);
    }
    root.querySelector(`.cut-grid .cut-slot-tab[data-panel="${id}"]`)?.click();
    return focusPanel(id);
  }
  // ---------- the Window menu: any panel, in this workspace ----------
  // A panel the current workspace lacks joins it as a tab of its dock slot (kept in `cut.addedPanels`), until that
  // tab is closed.
  const addedPanels = (ws) => {
    const all = ide.settings.get('cut.addedPanels', null);
    const list = all && Array.isArray(all[ws.id]) ? all[ws.id] : [];
    const own = new Set(ws.rows.flatMap((r) => r.slots.flatMap((x) => x.panels)));
    return list.filter((x) => x && typeof x.panel === 'string' && typeof x.slot === 'string' && !own.has(x.panel) && !DOCKED.has(x.panel));
  };
  const saveAdded = (wsId, list) => {
    const all = { ...(ide.settings.get('cut.addedPanels', null) || {}) };
    all[wsId] = list;
    ide.settings.set('cut.addedPanels', all);
  };
  const inWorkspace = (id) => !!root.querySelector(`.cut-grid .cut-slot-tab[data-panel="${id}"]`);
  // Shows a panel in the current workspace (its tab, or a new tab in the dock slot) and gives it the keyboard.
  function openPanel(id) {
    if (!ui.panels.has(id)) return false;
    if (DOCKED.has(id)) return setDock(true);
    if (!inWorkspace(id)) {
      const ws = WORKSPACES.find((w) => w.id === current) || WORKSPACES[0];
      let slotKey = null;
      ws.rows.forEach((r, ri) => r.slots.forEach((x, si) => { if (x.dock && !slotKey) slotKey = `${ri}:${si}`; }));
      saveAdded(ws.id, [...addedPanels(ws).filter((x) => x.panel !== id), { panel: id, slot: slotKey || '0:0' }]);
      setWorkspace(ws.id);
    }
    root.querySelector(`.cut-grid .cut-slot-tab[data-panel="${id}"]`)?.click();
    return focusPanel(id);
  }
  function closeAdded(id) {
    const ws = WORKSPACES.find((w) => w.id === current) || WORKSPACES[0];
    saveAdded(ws.id, addedPanels(ws).filter((x) => x.panel !== id));
    setWorkspace(ws.id);
  }
  const panelIds = () => [...PANEL_ORDER.filter((id) => ui.panels.has(id)), ...[...ui.panels.keys()].filter((id) => !PANEL_ORDER.includes(id))];
  const panelItems = () => panelIds().map((id) => (DOCKED.has(id)
    ? { label: panelTitle(id), checked: dockOpen(), keyAction: `Cut.window.${id}`, run: () => setDock(!dockOpen()) }
    : { label: panelTitle(id), checked: inWorkspace(id), keyAction: `Cut.window.${id}`, run: () => openPanel(id) }));

  // ---------- the AI dock ----------
  // The AI Assistant opens as a full-height column on the right of the window (the top bar's AI button, Window > AI
  // Assistant, Find Action), beside whatever workspace shows. Its width and whether it is open are kept in `cut.aiDock`.
  const DOCK_KEY = 'cut.aiDock';
  const DOCK_MIN = 260;
  const dockState = () => {
    const v = ide.settings.get(DOCK_KEY, null);
    return { open: !!v?.open, width: Number.isFinite(v?.width) ? v.width : 380 };
  };
  const dockOpen = () => !!dock && !dock.hidden;
  function buildDock() {
    dock = el('aside', 'cut-dock', undefined, { 'aria-label': tr('AI Assistant') });
    dock.hidden = true;
    const head = el('div', 'cut-dock-head');
    const close = el('button', 'cut-dock-close', '×', { type: 'button', title: tr('Close'), 'aria-label': tr('Close') });
    close.addEventListener('mousedown', (e) => { if (e.button === 0) e.preventDefault(); });
    close.addEventListener('click', () => setDock(false));
    head.append(icon('sparkle'), el('span', 'cut-dock-title', tr('AI Assistant')), close);
    dockBody = el('div', 'cut-dock-body');
    dock.append(head, dockBody);
    // Notification balloons sit in the lower right corner, over the dock's Send and Stop: they move left of the dock.
    ide.util.observeSize(dock, () => document.body.style.setProperty('--cut-dock-room', `${dock.hidden ? 0 : Math.round(dock.getBoundingClientRect().width) + 8}px`));
    dockSplit = el('div', 'cut-splitter v cut-dock-splitter');
    dockSplit.hidden = true;
    dockSplit.addEventListener('pointerdown', (e) => {
      if (e.button !== 0) return;
      e.preventDefault();
      dockSplit.setPointerCapture(e.pointerId);
      const start = e.clientX;
      const first = dock.getBoundingClientRect().width;
      const most = () => Math.max(DOCK_MIN, root.getBoundingClientRect().width * 0.5);
      // The dock is right of its splitter: dragging left widens it.
      const move = (m) => { dock.style.width = `${Math.round(Math.min(most(), Math.max(DOCK_MIN, first - (m.clientX - start))))}px`; };
      const up = () => {
        dockSplit.removeEventListener('pointermove', move);
        dockSplit.removeEventListener('pointerup', up);
        ide.settings.set(DOCK_KEY, { ...dockState(), width: Math.round(dock.getBoundingClientRect().width) });
      };
      dockSplit.addEventListener('pointermove', move);
      dockSplit.addEventListener('pointerup', up);
    });
  }
  function setDock(open, { focus = true } = {}) {
    if (!dock || !ui.panels.has('assistant')) return false;
    if (open) {
      const entry = panelHost('assistant');
      dock.style.width = `${dockState().width}px`;
      if (entry.host.parentNode !== dockBody) dockBody.appendChild(entry.host);
    } else {
      const entry = mounted.get('assistant');
      if (entry) shelf.appendChild(entry.host);
      if (app.focusPanel === 'assistant') app.setFocus(['timeline', 'program'].find((p) => root.querySelector(`.cut-grid .cut-panel[data-panel="${p}"]`)) || null);
    }
    dock.hidden = !open;
    dockSplit.hidden = !open;
    document.body.style.setProperty('--cut-dock-room', `${open ? Math.round(dock.getBoundingClientRect().width) + 8 : 0}px`);
    aiBtn?.setPressed(open);
    ide.settings.set(DOCK_KEY, { ...dockState(), open });
    if (open && focus) focusPanel('assistant');
    return open;
  }
  function aiButton() {
    aiBtn = button({ icon: 'sparkle', label: 'AI', title: tr('AI Assistant'), toggle: true, pressed: false, cls: 'cut-ai-btn', onClick: () => setDock(!dockOpen()) });
    return aiBtn;
  }
  // Window > Workspaces, as in Premiere: the workspaces, then Reset to Saved Layout and Save Changes.
  const workspaceItems = () => [
    ...WORKSPACES.map((ws) => ({ label: ws.title(), checked: ws.id === current, keyAction: `Cut.workspace.${ws.id}`, run: () => setWorkspace(ws.id) })),
    { separator: true },
    { label: tr('Reset to Saved Layout'), keyAction: 'Cut.workspace.reset', run: () => resetWorkspace() },
    { label: tr('Save Changes to This Workspace'), run: () => saveWorkspace() },
  ];
  const toolBarItem = () => ({ label: tr('Timeline Tool Bar'), checked: !!ide.settings.get('cut.timelineTools', false), run: () => ide.settings.set('cut.timelineTools', !ide.settings.get('cut.timelineTools', false)) });
  // The Window menu (the top bar's button and the menu bar's Window): every panel, then the workspaces.
  const windowMenuItems = () => [
    ...panelItems(),
    { separator: true },
    { label: tr('Workspaces'), submenu: workspaceItems },
    toolBarItem(),
    { label: tr('Maximize or Restore Active Frame'), keyAction: 'Cut.maximizePanel', run: () => toggleMaximize() },
  ];
  function windowButton() {
    const b = button({ icon: 'grid', label: tr('Window'), title: tr('Window'), cls: 'cut-window-btn', onClick: () => ui.menu(b, windowMenuItems()) });
    b.appendChild(el('span', 'cut-auto-caret', '▾'));
    b.setAttribute('aria-haspopup', 'menu');
    return b;
  }

  const markFocus = () => {
    for (const { host } of mounted.values()) host.classList.toggle('focused', host.dataset.panel === app.focusPanel);
  };

  // ---------- the project ----------
  let key = null; // the autosave and session key: the project path, or untitled-<id>
  let autosaveTimer = 0;
  let lastAutosave = null;
  let lastCopy = null;
  let copyTimer = 0;
  let changes = 0; // edits seen since the project was adopted
  let copiedAt = 0; // `changes` when the last copy was written
  const untitledKey = () => `untitled-${Date.now().toString(36)}${Math.random().toString(36).slice(2, 6)}`;
  const projectName = () => (app.path ? ui.basename(app.path).replace(/\.ncut$/i, '') : tr('Untitled'));
  // history.dirty knows only edits made since it was created; a recovered project is modified from the start.
  let forceDirty = false;
  const dirty = () => !!app.history?.dirty || forceDirty;
  // The project file's time when it was read or last written here (cut:projectWrite refuses to overwrite a newer one).
  let diskMtime = null;

  async function startSession(newKey) {
    const old = key;
    key = newKey;
    if (old && old !== newKey) await ide.api.invoke('cut:sessionEnd', old).catch(() => {});
    await ide.api.invoke('cut:sessionStart', newKey).catch((err) => log.warn(`session: ${err.message}`));
  }

  // history: a commands history; path: the .ncut file or null; opts.sessionKey: the session key to keep (a recovery);
  // opts.mtime: the file's time as read.
  async function adopt(history, path, { reason = 'open', sessionKey, mtime = null } = {}) {
    clearTimeout(autosaveTimer);
    ui.monitors?.program?.pause?.();
    ui.monitors?.source?.pause?.();
    diskMtime = path ? mtime : null;
    app.setHistory(history, path, reason);
    changes = 0;
    copiedAt = 0;
    history.onChange(() => { changes += 1; projectChanged(); });
    await startSession(sessionKey || path || untitledKey());
    refreshTitle();
    app.emit('lifecycle', { reason, path });
  }

  function newHistory(project) {
    return Cut.commands.createHistory(project);
  }
  // A new project takes the default durations of the settings page (ui-settings.js).
  const freshProject = () => Cut.model.createProject({ sequence: { name: tr('Sequence {n}', { n: 1 }) }, settings: ui.projectDefaults?.() || {} });
  async function newProject({ ask = true } = {}) {
    if (ask && !(await askToSave())) return false;
    await adopt(newHistory(freshProject()), null, { reason: 'new' });
    return true;
  }

  // Text of a .ncut file -> a history, or an Error with a message for the person.
  function historyFromText(text) {
    let json;
    try { json = JSON.parse(text); } catch { throw Object.assign(new Error('This file is not a Nano Studio Cut project.'), { code: 'notProject' }); }
    if (!json || json.format !== 'ncut') throw Object.assign(new Error('This file is not a Nano Studio Cut project.'), { code: 'notProject' });
    // A part of the file that is not what migrate expects (a null clip, tracks that are not a list) threw a TypeError
    // whose text ("Cannot read properties of null") was all the person saw.
    try {
      return newHistory(Cut.model.migrate(json));
    } catch (err) {
      if (err?.code) throw err;
      throw Object.assign(new Error('The project file is damaged and cannot be opened.'), { code: 'damaged', detail: err?.message || String(err) });
    }
  }

  async function openPath(path, { ask = true } = {}) {
    if (ask && !(await askToSave())) return false;
    const r = await ide.api.invoke('cut:projectRead', path);
    if (r?.missing) { ui.notify(tr('The project file is gone: {path}', { path }), { kind: 'warn' }); return false; }
    if (r?.error) { ui.notify(tr('The project could not be opened: {error}', { error: r.error.message || r.error.code || String(r.error) }), { kind: 'error' }); return false; }
    let history;
    try { history = historyFromText(r.text); } catch (err) { ui.report(err); return false; }
    // An autosave copy is not a project's file: the app deletes old ones, so it opens unsaved and asks for a place.
    await adopt(history, r.autosave ? null : r.path || path, { reason: 'open', mtime: r.mtime ?? null });
    if (r.autosave) {
      forceDirty = true;
      refreshTitle();
      ui.notify(tr('This is an autosave copy, which Nano Studio Cut deletes when it gets old. Save the project to keep it.'), { kind: 'warn' });
    }
    ui.media?.checkOffline?.(app);
    return true;
  }
  async function open() {
    const path = await ide.api.invoke('cut:pickProject', { title: tr('Open Project'), filterName: tr('Nano Studio Cut project') });
    if (!path) return false;
    return openPath(path);
  }

  // main's failures are { error: text, code }.
  function saveFailed(r) {
    ui.notify(r?.code === 'autosave'
      ? tr('Projects are not saved in the Autosave folder, where Nano Studio Cut deletes old files. Choose another folder.')
      : tr('The project could not be saved: {error}', { error: (typeof r?.error === 'string' ? r.error : r?.error?.message) || r?.code || tr('unknown error') }), { kind: 'error' });
    return false;
  }
  async function writeTo(path, { overwrite = false } = {}) {
    const history = app.history;
    // Taken before the text: an edit made while the file is written is not marked saved.
    const at = history.mark();
    const text = history.serialize();
    const same = !!app.path && app.path.toLowerCase() === path.toLowerCase();
    const r = await ide.api.invoke('cut:projectWrite', path, text, same && !overwrite && diskMtime !== null ? { mtime: diskMtime } : {});
    if (r?.code === 'changed') {
      const yes = await ui.confirm(tr('{name} was changed on disk after it was opened here, by another window or program. Overwrite it with this project?', { name: ui.basename(path) }),
        { title: tr('Save Project'), ok: tr('Overwrite') });
      return yes && app.history === history ? writeTo(path, { overwrite: true }) : false;
    }
    if (!r?.ok) return saveFailed(r);
    if (app.history !== history) return true;
    history.markSaved(at);
    diskMtime = r.mtime ?? null;
    clearTimeout(autosaveTimer);
    if (dirty()) autosaveTimer = setTimeout(autosaveNow, AUTOSAVE_MS);
    const was = app.path;
    app.path = r.path || path;
    if (!was || was.toLowerCase() !== app.path.toLowerCase()) await startSession(app.path);
    refreshTitle();
    ui.toast(tr('Saved'));
    app.emit('lifecycle', { reason: 'save', path: app.path });
    return true;
  }
  async function save() {
    if (!app.history) return false;
    if (!app.path) return saveAs();
    return writeTo(app.path);
  }
  async function saveAs() {
    const home = await ide.api.invoke('cut:home').catch(() => null);
    const name = `${projectName()}.ncut`;
    const defaultPath = app.path || (home?.projects ? `${home.projects}\\${name}` : name);
    const path = await ide.api.invoke('cut:saveAs', { defaultPath, filters: FILTERS(), title: tr('Save Project As') });
    if (!path) return false;
    return writeTo(path);
  }
  // Save a Copy (Ctrl+Alt+S): the project as it is now into another file; the open project stays where it was, with
  // its unsaved changes still unsaved.
  async function saveCopy() {
    if (!app.history) return false;
    const home = await ide.api.invoke('cut:home').catch(() => null);
    const name = tr('{name} copy', { name: projectName() });
    const dir = app.path ? app.path.replace(/[\\/][^\\/]*$/, '') : home?.projects || '';
    const path = await ide.api.invoke('cut:saveAs', { defaultPath: dir ? `${dir}\\${name}.ncut` : `${name}.ncut`, filters: FILTERS(), title: tr('Save a Copy') });
    if (!path) return false;
    const r = await ide.api.invoke('cut:projectWrite', path, app.history.serialize());
    if (!r?.ok) return saveFailed(r);
    ui.toast(tr('Saved a copy as {name}', { name: ui.basename(r.path || path) }));
    return true;
  }

  // Unsaved changes: asks Save, Don't Save or Cancel. -> true when it is fine to go on (saved or discarded).
  let asking = null;
  function askToSave({ closing = false } = {}) {
    if (!dirty()) return Promise.resolve(true);
    if (asking) return asking;
    asking = new Promise((resolve) => {
      let answer = false;
      const body = el('div', 'dialog-message', tr('Save the changes to {name}?', { name: projectName() }));
      body.appendChild(el('div', 'cut-dialog-note', closing ? tr('Your changes are lost if you close without saving.') : tr('Your changes are lost if you go on without saving.')));
      const dlg = ui.dialog({
        title: tr('Save Changes?'),
        id: 'cutSaveChanges',
        body,
        width: 440,
        onClose: () => { asking = null; resolve(answer); },
        buttons: [
          { label: tr('Save'), primary: true, run: async () => { answer = await save(); } },
          { label: tr("Don't Save"), run: () => { answer = true; } },
          { label: tr('Cancel') },
        ],
      });
      dlg.el.dataset.closing = String(closing);
    });
    return asking;
  }

  // Closing the window: while the project has unsaved changes the page holds the unload (Electron then keeps the
  // window open) and asks; the answer closes the window for real. The IDE's own close question (editors.js) knows only
  // documents, so the project joins here.
  let closeAllowed = false;
  addEventListener('beforeunload', (e) => {
    if (closeAllowed || !app || !dirty()) {
      endSessionOnUnload();
      return;
    }
    e.preventDefault();
    e.returnValue = false;
    setTimeout(async () => {
      if (await askToSave({ closing: true })) {
        closeAllowed = true;
        ide.api.invoke('window:closeNow');
      }
    });
  });
  let sessionEnded = false;
  function endSessionOnUnload() {
    if (sessionEnded || !key) return;
    sessionEnded = true;
    clearTimeout(autosaveTimer);
    clearInterval(copyTimer);
    ide.api.invoke('cut:sessionEnd', key).catch(() => {});
  }

  // ---------- autosave ----------
  function projectChanged() {
    refreshTitle();
    clearTimeout(autosaveTimer);
    if (!dirty()) return;
    autosaveTimer = setTimeout(autosaveNow, AUTOSAVE_MS);
  }
  async function autosaveNow() {
    clearTimeout(autosaveTimer);
    if (!app.history || !key || !dirty()) return null;
    // A slider drag in progress is not a state worth keeping; its commit schedules another one.
    if (app.history.grouping) { autosaveTimer = setTimeout(autosaveNow, AUTOSAVE_MS); return null; }
    const r = await ide.api.invoke('cut:autosave', key, app.history.serialize(), { latest: true }).catch((err) => ({ error: { message: err.message } }));
    if (r?.ok) {
      lastAutosave = { file: r.file, time: Date.now() };
      refreshSaveState();
      app.emit('autosaved', lastAutosave);
    } else log.warn(`autosave failed: ${r?.error?.message || r?.error?.code}`);
    return r;
  }
  // A copy that stays (one of the newest `keep`), when there are unsaved changes the last copy does not have.
  async function autosaveCopy({ force = false } = {}) {
    if (!app.history || !key || !dirty() || app.history.grouping) return null;
    if (!force && changes === copiedAt) return null;
    const at = changes;
    const r = await ide.api.invoke('cut:autosave', key, app.history.serialize(), { keep: copyKeep() }).catch((err) => ({ error: { message: err.message } }));
    if (r?.ok) {
      copiedAt = at;
      lastCopy = { file: r.file, time: Date.now() };
      app.emit('autosaved', { ...lastCopy, copy: true });
    } else log.warn(`autosave copy failed: ${r?.error?.message || r?.error?.code}`);
    return r;
  }
  function scheduleCopies() {
    clearInterval(copyTimer);
    copyTimer = setInterval(() => { autosaveCopy().catch(() => {}); }, copyMinutes() * 60000);
  }
  ide.on('settingsChanged', (k) => { if (k === 'cut.autosave.minutes' && app) scheduleCopies(); });

  // ---------- recovery ----------
  async function offerRecovery() {
    const list = await ide.api.invoke('cut:recovery').catch(() => []);
    if (!Array.isArray(list) || !list.length) return;
    const nameOf = (k) => (/^untitled-/.test(k) ? tr('Untitled') : ui.basename(k).replace(/\.ncut$/i, ''));
    const body = el('div', 'cut-recovery');
    body.appendChild(el('div', 'dialog-message', tr('Nano Studio Cut did not close properly last time. These projects have changes that were autosaved but not saved:')));
    const items = el('div', 'cut-recovery-list');
    let chosen = list[0];
    list.forEach((r, i) => {
      const row = el('label', 'cut-recovery-row');
      const radio = el('input', null, undefined, { type: 'radio', name: 'cutRecovery' });
      radio.checked = i === 0;
      radio.addEventListener('change', () => { if (radio.checked) chosen = r; });
      const text = el('span', 'cut-recovery-name', nameOf(r.key));
      text.dataset.userText = '';
      const when = el('span', 'cut-recovery-time', new Date(r.time).toLocaleString());
      row.append(radio, text, when);
      if (!/^untitled-/.test(r.key)) row.title = r.key;
      items.appendChild(row);
    });
    body.appendChild(items);
    ui.dialog({
      title: tr('Recover Project'),
      id: 'cutRecovery',
      body,
      width: 480,
      buttons: [
        { label: tr('Recover'), primary: true, run: () => { recover(chosen, list); } },
        { label: tr('Discard'), run: () => { for (const r of list) ide.api.invoke('cut:recoveryDismiss', r.key).catch(() => {}); } },
      ],
    });
  }
  async function recover(item, all) {
    const r = await ide.api.invoke('cut:projectRead', item.file);
    if (!r?.text) { ui.notify(tr('The autosave could not be read.'), { kind: 'error' }); return; }
    let history;
    try { history = historyFromText(r.text); } catch (err) { ui.report(err); return; }
    const path = /^untitled-/.test(item.key) ? null : item.key;
    await adopt(history, path, { reason: 'recover', sessionKey: item.key });
    // Recovered changes are not saved anywhere yet: the project counts as modified until the person saves it.
    forceDirty = true;
    refreshTitle();
    for (const other of all) if (other !== item) ide.api.invoke('cut:recoveryDismiss', other.key).catch(() => {});
    ui.media?.checkOffline?.(app);
  }
  // File > Restore Autosave: the autosaves of the open project (its interval copies and its latest state), newest
  // first; the one chosen replaces the project in the editor, unsaved, under the same file and session.
  async function restoreAutosave() {
    if (!app.history || !key) return false;
    const list = await ide.api.invoke('cut:autosaves', key).catch(() => []);
    if (!Array.isArray(list) || !list.length) { ui.notify(tr('There are no autosaves of {name}.', { name: projectName() })); return false; }
    const body = el('div', 'cut-recovery');
    body.appendChild(el('div', 'dialog-message', tr('Choose an autosave of {name} to open in its place. The project stays unsaved until you save it.', { name: projectName() })));
    const items = el('div', 'cut-recovery-list cut-restore-list');
    let chosen = list[0];
    list.forEach((a, i) => {
      const row = el('label', 'cut-recovery-row');
      const radio = el('input', null, undefined, { type: 'radio', name: 'cutRestore' });
      radio.checked = i === 0;
      radio.addEventListener('change', () => { if (radio.checked) chosen = a; });
      row.title = a.file;
      row.append(radio, el('span', 'cut-recovery-name', new Date(a.time).toLocaleString()), el('span', 'cut-recovery-time', a.latest ? tr('Latest state') : tr('Autosave copy')));
      items.appendChild(row);
    });
    body.appendChild(items);
    let restore = false;
    await new Promise((resolve) => {
      ui.dialog({
        title: tr('Restore Autosave'),
        id: 'cutRestoreAutosave',
        body,
        width: 480,
        onClose: resolve,
        buttons: [
          { label: tr('Restore'), primary: true, run: () => { restore = true; } },
          { label: tr('Cancel') },
        ],
      });
    });
    if (!restore || !(await askToSave())) return false;
    const r = await ide.api.invoke('cut:projectRead', chosen.file);
    if (!r?.text) { ui.notify(tr('The autosave could not be read.'), { kind: 'error' }); return false; }
    let history;
    try { history = historyFromText(r.text); } catch (err) { ui.report(err); return false; }
    await adopt(history, app.path, { reason: 'recover', sessionKey: key, mtime: diskMtime });
    forceDirty = true;
    refreshTitle();
    ui.toast(tr('Restored the autosave of {time}', { time: new Date(chosen.time).toLocaleString() }));
    ui.media?.checkOffline?.(app);
    return true;
  }
  // ---------- top bar ----------
  let nameEl = null;
  let stateEl = null;
  let undoBtn = null;
  let redoBtn = null;
  function topBar() {
    const bar = el('header', 'cut-topbar');
    const brand = el('div', 'cut-brand');
    brand.append(el('span', 'cut-brand-logo', 'C'), el('span', 'cut-brand-name', 'Nano Studio Cut'));
    const file = el('div', 'cut-topbar-group');
    file.append(
      button({ icon: 'newFile', title: tr('New Project'), action: 'newProject', cls: 'cut-new' }),
      button({ icon: 'open', title: tr('Open Project…'), action: 'open', cls: 'cut-open' }),
      button({ icon: 'save', title: tr('Save'), action: 'save', cls: 'cut-save' }),
      button({ icon: 'download', title: tr('Save As…'), action: 'saveAs', cls: 'cut-save-as' }),
    );
    const edit = el('div', 'cut-topbar-group');
    undoBtn = button({ icon: 'undo', title: tr('Undo'), action: 'undo', cls: 'cut-undo' });
    redoBtn = button({ icon: 'redo', title: tr('Redo'), action: 'redo', cls: 'cut-redo' });
    edit.append(undoBtn, redoBtn);
    const project = el('div', 'cut-project-name');
    nameEl = el('span', 'cut-project-title');
    nameEl.dataset.userText = '';
    stateEl = el('span', 'cut-save-state');
    project.append(nameEl, stateEl);
    const tabs = el('nav', 'cut-ws-tabs', undefined, { role: 'tablist' });
    for (const ws of WORKSPACES) {
      const t = el('button', 'cut-ws-tab', ws.title(), { type: 'button', role: 'tab', 'data-ws': ws.id });
      ide.keymap.tooltip(t, ws.title(), `Cut.workspace.${ws.id}`);
      t.addEventListener('mousedown', (e) => { if (e.button === 0) e.preventDefault(); });
      t.addEventListener('click', () => setWorkspace(ws.id));
      // As Premiere's workspace tabs: Reset to Saved Layout and Save Changes for that workspace.
      t.addEventListener('contextmenu', (e) => {
        e.preventDefault();
        ui.menu(e.clientX, e.clientY, [
          { label: tr('Reset to Saved Layout'), keyAction: ws.id === current ? 'Cut.workspace.reset' : undefined, run: () => resetWorkspace(ws.id) },
          { label: tr('Save Changes to This Workspace'), run: () => saveWorkspace(ws.id) },
        ]);
      });
      tabs.appendChild(t);
    }
    // The tabs that do not fit go into a » menu at the end, as in Premiere.
    wsMore = el('button', 'cut-ws-more', '»', { type: 'button', title: tr('More Workspaces'), 'aria-label': tr('More Workspaces') });
    wsMore.hidden = true;
    wsMore.addEventListener('mousedown', (e) => { if (e.button === 0) e.preventDefault(); });
    wsMore.addEventListener('click', () => ui.menu(wsMore, WORKSPACES.filter((ws) => tabs.querySelector(`.cut-ws-tab[data-ws="${ws.id}"]`)?.hidden)
      .map((ws) => ({ label: ws.title(), run: () => setWorkspace(ws.id) }))));
    tabs.appendChild(wsMore);
    wsTabs = tabs;
    const right = el('div', 'cut-topbar-group right');
    const exportBtn = button({ icon: 'export', label: tr('Export'), title: tr('Export'), action: 'export', cls: 'cut-export-btn accent' });
    // The Automation menu (ui-auto.js) when it loaded.
    right.appendChild(windowButton());
    if (ui.auto?.topBarButton) right.appendChild(ui.auto.topBarButton());
    // AI beside Automation: opens and closes the AI dock.
    if (ui.panels.has('assistant')) right.appendChild(aiButton());
    // Settings and the keyboard shortcuts (ui-settings.js, ui-shortcuts.js) when they loaded.
    if (ui.settingsButton) right.appendChild(ui.settingsButton());
    right.append(button({ icon: 'add', title: tr('Import Media…'), action: 'import', cls: 'cut-import-btn' }), exportBtn);
    bar.append(brand, file, edit, project, tabs, right);
    ide.util.observeSize(bar, () => fitTabs());
    return bar;
  }
  let wsTabs = null;
  let wsMore = null;
  // Hides the last workspace tabs (never the one shown) until the rest fit, and shows » for them.
  function fitTabs() {
    if (!wsTabs) return;
    const list = [...wsTabs.querySelectorAll('.cut-ws-tab')];
    for (const t of list) t.hidden = false;
    wsMore.hidden = true;
    if (wsTabs.scrollWidth <= wsTabs.clientWidth + 1) return;
    wsMore.hidden = false;
    for (const t of list.reverse()) {
      if (wsTabs.scrollWidth <= wsTabs.clientWidth + 1) break;
      if (t.dataset.ws !== current) t.hidden = true;
    }
  }
  function refreshTitle() {
    if (!nameEl || !app.history) return;
    const name = projectName();
    nameEl.textContent = name;
    nameEl.title = app.path || '';
    const isDirty = dirty();
    root.classList.toggle('dirty', isDirty);
    undoBtn.disabled = !app.history.canUndo;
    redoBtn.disabled = !app.history.canRedo;
    document.title = `${isDirty ? '● ' : ''}${name} - ${ide.appTitle}`;
    refreshSaveState();
  }
  function refreshSaveState() {
    if (!stateEl) return;
    const isDirty = dirty();
    stateEl.textContent = isDirty ? (lastAutosave ? tr('Autosaved {time}', { time: new Date(lastAutosave.time).toLocaleTimeString() }) : tr('Modified')) : app.path ? tr('Saved') : '';
    stateEl.dataset.state = isDirty ? 'dirty' : 'saved';
  }

  // ---------- start ----------
  async function start(host, theApp) {
    app = theApp;
    root = el('div', 'cut-root');
    stage = el('div', 'cut-stage');
    shelf = el('div', 'cut-shelf');
    shelf.hidden = true;
    // Premiere's menu bar (ui-menubar.js) over the top bar's quick buttons, when that file loaded.
    const menubar = ui.menubar?.build?.(app);
    if (menubar) root.appendChild(menubar);
    buildDock();
    const body = el('div', 'cut-body');
    body.append(stage, dockSplit, dock);
    root.append(topBar(), body, shelf);
    host.replaceChildren(root);
    root.addEventListener('pointermove', (e) => { pointer = { x: e.clientX, y: e.clientY }; }, { passive: true });
    root.addEventListener('pointerdown', (e) => {
      const p = e.target.closest?.('.cut-panel');
      if (p) app.setFocus(p.dataset.panel);
    }, true);
    root.addEventListener('focusin', (e) => {
      const p = e.target.closest?.('.cut-panel');
      if (p) app.setFocus(p.dataset.panel);
    });
    app.on('focus', markFocus);
    app.on('project', () => refreshTitle());
    // Saving after a recovery makes it a normal project again.
    app.on('lifecycle', ({ reason }) => { if (reason !== 'recover') { forceDirty = false; refreshTitle(); } });
    await adopt(newHistory(freshProject()), null, { reason: 'new' });
    scheduleCopies();
    setWorkspace(ide.settings.get('cut.workspace', 'editing'));
    if (dockState().open) setDock(true, { focus: false });
    // Find Action reaches every panel: "Window: History" and so on.
    for (const id of panelIds()) {
      if (ide.actions.some((a) => a.id === `Cut.window.${id}`)) continue;
      ide.registerAction({ id: `Cut.window.${id}`, title: tr('Window: {panel}', { panel: panelTitle(id) }), when: () => !!document.querySelector('.cut-root'), run: () => openPanel(id) });
    }
    // The user's Cut keys (ui-shortcuts.js) reach the actions registered just now too.
    ui.shortcuts?.apply?.();
    offerRecovery().catch((err) => log.warn(`recovery: ${err?.message || err}`));
  }

  Object.defineProperty(ui, 'workspace', { get: () => current, configurable: true });
  Object.defineProperty(ui, 'dockOpen', { get: () => dockOpen(), configurable: true });
  Object.assign(ui, {
    start,
    workspaces: WORKSPACES,
    setWorkspace,
    resetWorkspace,
    saveWorkspace,
    toggleMaximize,
    setDock,
    showPanel,
    openPanel,
    windowMenuItems,
    workspaceItems,
    panelItems,
    focusPanel,
    mountedPanel: (id) => mounted.get(id)?.host || null,
    lifecycle: {
      newProject, open, openPath, save, saveAs, saveCopy, askToSave, autosaveNow, autosaveCopy, offerRecovery, restoreAutosave,
      get key() { return key; },
      get dirty() { return dirty(); },
      get lastAutosave() { return lastAutosave; },
      get lastCopy() { return lastCopy; },
      projectName,
    },
  });
})();
