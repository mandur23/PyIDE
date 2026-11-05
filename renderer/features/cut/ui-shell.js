// The editor's frame (docs/cut-architecture.md section 10): the top bar, the workspaces (fixed panel layouts the top
// tabs switch between) and the project's life: an untitled project at start, New, Open, Save, Save As, an autosave
// 2 s after edits stop, the recovery offer after a crash, and the question about unsaved changes before the project
// or the window closes.
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
  const FILTERS = () => [{ name: tr('Nano Studio Cut project'), extensions: ['ncut'] }];

  // rows top to bottom, slots left to right; sizes are percentages. A slot shows its panels as tabs.
  const WORKSPACES = [
    { id: 'editing', title: () => tr('Editing'), rows: [
      { size: 55, slots: [{ size: 42, panels: ['source', 'controls'] }, { size: 58, panels: ['program'] }] },
      { size: 45, slots: [{ size: 28, panels: ['project', 'effects'] }, { size: 72, panels: ['timeline'] }] },
    ] },
    { id: 'color', title: () => tr('Color'), rows: [
      { size: 60, slots: [{ size: 68, panels: ['program'] }, { size: 32, panels: ['color', 'controls'] }] },
      { size: 40, slots: [{ size: 26, panels: ['project', 'effects'] }, { size: 74, panels: ['timeline'] }] },
    ] },
    { id: 'captions', title: () => tr('Captions and Graphics'), rows: [
      { size: 58, slots: [{ size: 30, panels: ['captions'] }, { size: 44, panels: ['program'] }, { size: 26, panels: ['text', 'controls'] }] },
      { size: 42, slots: [{ size: 26, panels: ['project', 'effects'] }, { size: 74, panels: ['timeline'] }] },
    ] },
    { id: 'export', title: () => tr('Export'), rows: [
      { size: 62, slots: [{ size: 36, panels: ['export'] }, { size: 64, panels: ['program'] }] },
      { size: 38, slots: [{ size: 100, panels: ['timeline'] }] },
    ] },
  ];

  let app = null;
  let root = null;
  let stage = null; // where the workspace grid goes
  let shelf = null; // panels not shown in the current workspace wait here
  let current = null; // workspace id
  const mounted = new Map(); // panel id -> {host, body, dispose, focus}
  const activeTab = new Map(); // `${workspace}:${slot index}` -> panel id

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
    for (const { host } of mounted.values()) shelf.appendChild(host);
    const sizes = savedSizes(ws);
    const grid = el('div', 'cut-grid', undefined, { 'data-workspace': ws.id });
    ws.rows.forEach((rowDef, ri) => {
      if (ri) grid.appendChild(splitter('h', grid, ws, ri));
      const rowEl = el('div', 'cut-row');
      rowEl.style.flexGrow = String(sizes.rows[ri]);
      rowDef.slots.forEach((slotDef, si) => {
        if (si) rowEl.appendChild(splitter('v', rowEl, ws, ri, si));
        rowEl.appendChild(slot(ws, ri, si, slotDef, sizes.slots[ri][si]));
      });
      grid.appendChild(rowEl);
    });
    stage.replaceChildren(grid);
    root.dataset.workspace = ws.id;
    app.emit('workspace', { id: ws.id });
    // The keyboard stays with its panel when that panel is still on screen; otherwise the main one of this workspace.
    if (!grid.querySelector(`.cut-panel[data-panel="${app.focusPanel}"]`)) {
      const first = ['timeline', 'program'].find((p) => grid.querySelector(`.cut-panel[data-panel="${p}"]`));
      if (first) app.setFocus(first);
    }
    markFocus();
  }

  function slot(ws, ri, si, def, size) {
    const s = el('div', 'cut-slot');
    s.style.flexGrow = String(size);
    const available = def.panels.filter((p) => ui.panels.has(p));
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
      const t = el('button', 'cut-slot-tab', panelTitle(id), { 'data-panel': id, role: 'tab', type: 'button' });
      t.addEventListener('mousedown', (e) => { if (e.button === 0) e.preventDefault(); });
      t.addEventListener('click', () => show(id, { focus: true }));
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
      const a = bar.previousElementSibling;
      const b = bar.nextElementSibling;
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
        const grid = stage.querySelector('.cut-grid');
        const rows = [...grid.querySelectorAll(':scope > .cut-row')];
        ide.settings.set(sizesKey(ws.id), {
          rows: rows.map((r) => Number(r.style.flexGrow) || 1),
          slots: rows.map((r) => [...r.querySelectorAll(':scope > .cut-slot')].map((x) => Number(x.style.flexGrow) || 1)),
        });
      };
      bar.addEventListener('pointermove', move);
      bar.addEventListener('pointerup', up);
    });
    return bar;
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
    const tab = root.querySelector(`.cut-grid .cut-slot-tab[data-panel="${id}"]`);
    if (!tab) {
      const ws = WORKSPACES.find((w) => w.rows.some((r) => r.slots.some((s) => s.panels.includes(id))));
      if (!ws) return false;
      setWorkspace(ws.id);
    }
    root.querySelector(`.cut-grid .cut-slot-tab[data-panel="${id}"]`)?.click();
    return focusPanel(id);
  }
  const markFocus = () => {
    for (const { host } of mounted.values()) host.classList.toggle('focused', host.dataset.panel === app.focusPanel);
  };

  // ---------- the project ----------
  let key = null; // the autosave and session key: the project path, or untitled-<id>
  let autosaveTimer = 0;
  let lastAutosave = null;
  const untitledKey = () => `untitled-${Date.now().toString(36)}${Math.random().toString(36).slice(2, 6)}`;
  const projectName = () => (app.path ? ui.basename(app.path).replace(/\.ncut$/i, '') : tr('Untitled'));
  // history.dirty knows only edits made since it was created; a recovered project is modified from the start.
  let forceDirty = false;
  const dirty = () => !!app.history?.dirty || forceDirty;

  async function startSession(newKey) {
    const old = key;
    key = newKey;
    if (old && old !== newKey) await ide.api.invoke('cut:sessionEnd', old).catch(() => {});
    await ide.api.invoke('cut:sessionStart', newKey).catch((err) => log.warn(`session: ${err.message}`));
  }

  // history: a commands history; path: the .ncut file or null; opts.key: the session key to keep (a recovery).
  async function adopt(history, path, { reason = 'open', sessionKey } = {}) {
    clearTimeout(autosaveTimer);
    ui.monitors?.program?.pause?.();
    ui.monitors?.source?.pause?.();
    app.setHistory(history, path, reason);
    history.onChange(() => projectChanged());
    await startSession(sessionKey || path || untitledKey());
    refreshTitle();
    app.emit('lifecycle', { reason, path });
  }

  function newHistory(project) {
    return Cut.commands.createHistory(project);
  }
  async function newProject({ ask = true } = {}) {
    if (ask && !(await askToSave())) return false;
    await adopt(newHistory(Cut.model.createProject({ sequence: { name: tr('Sequence {n}', { n: 1 }) } })), null, { reason: 'new' });
    return true;
  }

  // Text of a .ncut file -> a history, or an Error with a message for the person.
  function historyFromText(text) {
    let json;
    try { json = JSON.parse(text); } catch { throw Object.assign(new Error('This file is not a Nano Studio Cut project.'), { code: 'notProject' }); }
    if (!json || json.format !== 'ncut') throw Object.assign(new Error('This file is not a Nano Studio Cut project.'), { code: 'notProject' });
    const project = Cut.model.migrate(json);
    return newHistory(project);
  }

  async function openPath(path, { ask = true } = {}) {
    if (ask && !(await askToSave())) return false;
    const r = await ide.api.invoke('cut:projectRead', path);
    if (r?.missing) { ui.notify(tr('The project file is gone: {path}', { path }), { kind: 'warn' }); return false; }
    if (r?.error) { ui.notify(tr('The project could not be opened: {error}', { error: r.error.message || r.error.code || String(r.error) }), { kind: 'error' }); return false; }
    let history;
    try { history = historyFromText(r.text); } catch (err) { ui.report(err); return false; }
    await adopt(history, r.path || path, { reason: 'open' });
    ui.media?.checkOffline?.(app);
    return true;
  }
  async function open() {
    const path = await ide.api.invoke('cut:pickProject', { title: tr('Open Project'), filterName: tr('Nano Studio Cut project') });
    if (!path) return false;
    return openPath(path);
  }

  async function writeTo(path) {
    const text = app.history.serialize();
    const r = await ide.api.invoke('cut:projectWrite', path, text);
    if (!r?.ok) {
      ui.notify(tr('The project could not be saved: {error}', { error: r?.error?.message || r?.error?.code || tr('unknown error') }), { kind: 'error' });
      return false;
    }
    app.history.markSaved();
    clearTimeout(autosaveTimer);
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
    const r = await ide.api.invoke('cut:autosave', key, app.history.serialize()).catch((err) => ({ error: { message: err.message } }));
    if (r?.ok) {
      lastAutosave = { file: r.file, time: Date.now() };
      refreshSaveState();
      app.emit('autosaved', lastAutosave);
    } else log.warn(`autosave failed: ${r?.error?.message || r?.error?.code}`);
    return r;
  }

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
      t.addEventListener('mousedown', (e) => { if (e.button === 0) e.preventDefault(); });
      t.addEventListener('click', () => setWorkspace(ws.id));
      tabs.appendChild(t);
    }
    const right = el('div', 'cut-topbar-group right');
    const exportBtn = button({ icon: 'export', label: tr('Export'), title: tr('Export'), action: 'export', cls: 'cut-export-btn accent' });
    right.append(button({ icon: 'add', title: tr('Import Media…'), action: 'import', cls: 'cut-import-btn' }), exportBtn);
    bar.append(brand, file, edit, project, tabs, right);
    return bar;
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
    root.append(topBar(), stage, shelf);
    host.replaceChildren(root);
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
    await adopt(newHistory(Cut.model.createProject({ sequence: { name: tr('Sequence {n}', { n: 1 }) } })), null, { reason: 'new' });
    setWorkspace(ide.settings.get('cut.workspace', 'editing'));
    offerRecovery().catch((err) => log.warn(`recovery: ${err?.message || err}`));
  }

  Object.defineProperty(ui, 'workspace', { get: () => current, configurable: true });
  Object.assign(ui, {
    start,
    workspaces: WORKSPACES,
    setWorkspace,
    showPanel,
    focusPanel,
    mountedPanel: (id) => mounted.get(id)?.host || null,
    lifecycle: {
      newProject, open, openPath, save, saveAs, askToSave, autosaveNow, offerRecovery,
      get key() { return key; },
      get dirty() { return dirty(); },
      get lastAutosave() { return lastAutosave; },
      projectName,
    },
  });
})();
