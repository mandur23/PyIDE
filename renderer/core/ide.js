// PyIDE core: editor, tabs, project tree, and the registries features plug into (see FEATURES.md).
const $ = (id) => document.getElementById(id);
const el = (tag, cls, text) => {
  const n = document.createElement(tag);
  if (cls) n.className = cls;
  if (text !== undefined) n.textContent = text;
  return n;
};

const basename = (p) => p.split(/[\\/]/).pop();
const dirname = (p) => p.slice(0, Math.max(p.lastIndexOf('\\'), p.lastIndexOf('/')));
const joinPath = (a, b) => `${a.replace(/[\\/]+$/, '')}\\${b}`;
const samePath = (a, b) => !!a && !!b && a.toLowerCase() === b.toLowerCase();
// `p` is `dir` itself or inside it: a whole-segment prefix, so C:\proj\pkg does not contain C:\proj\pkg2.
const isUnder = (p, dir) => {
  if (!p || !dir) return false;
  const a = p.toLowerCase();
  const b = dir.toLowerCase().replace(/[\\/]+$/, '');
  return a === b || (a.startsWith(b) && '\\/'.includes(a[b.length]));
};

const LANG_BY_EXT = { py: 'python', pyw: 'python', pyi: 'python', js: 'javascript', ts: 'typescript', json: 'json',
  md: 'markdown', html: 'html', css: 'css', yml: 'yaml', yaml: 'yaml', toml: 'ini', cfg: 'ini', ini: 'ini',
  xml: 'xml', sh: 'shell', ps1: 'powershell', sql: 'sql', txt: 'plaintext' };

const ide = (window.ide = {
  t: tr,
  root: null,
  monaco: null,
  editor: null,
  tabs: [],
  active: null,
  interps: [],
  actions: [],
  toolWindows: new Map(),
  util: { $, el, basename, dirname, joinPath, samePath, isUnder, rel: (p) => (ide.root && p.toLowerCase().startsWith(ide.root.toLowerCase()) ? p.slice(ide.root.length + 1) : p) },
});

// ---------- events ----------
const listeners = new Map();
ide.on = (evt, fn) => {
  if (!listeners.has(evt)) listeners.set(evt, new Set());
  listeners.get(evt).add(fn);
  return () => listeners.get(evt).delete(fn);
};
ide.emit = (evt, ...args) => {
  for (const fn of listeners.get(evt) || []) {
    try { fn(...args); } catch (err) { console.error(`listener for ${evt} failed`, err); }
  }
};

// ---------- settings ----------
// Persisted by the main process (userData/settings.json), written synchronously so nothing is lost on restart.
const settingsCache = window.__initialSettings || {};
ide.settings = {
  get: (key, fallback) => (key in settingsCache ? settingsCache[key] : fallback),
  set(key, value) {
    settingsCache[key] = value;
    api.saveSettingsSync(settingsCache);
    ide.emit('settingsChanged', key, value);
  },
  all: () => ({ ...settingsCache }),
};

// ---------- processes ----------
const procHandlers = new Map();
const procBuffers = new Map();
api.on('proc:data', (m) => {
  const h = procHandlers.get(m.id);
  if (h) h.data?.(m.text, m.stream);
  else (procBuffers.get(m.id) || procBuffers.set(m.id, []).get(m.id)).push(m);
});
api.on('proc:exit', (m) => {
  const h = procHandlers.get(m.id);
  if (h) { procHandlers.delete(m.id); h.exit?.(m.code); }
  else (procBuffers.get(m.id) || procBuffers.set(m.id, []).get(m.id)).push({ ...m, exit: true });
});
ide.proc = {
  // Routes output of a process started by a feature's main-side handler; output that arrived early is replayed.
  attach(id, handlers) {
    procHandlers.set(id, handlers);
    for (const m of procBuffers.get(id) || []) {
      if (m.exit) { procHandlers.delete(id); handlers.exit?.(m.code); } else handlers.data?.(m.text, m.stream);
    }
    procBuffers.delete(id);
  },
  input: (id, text) => api.input(id, text),
  closeInput: (id) => api.closeInput(id),
  kill: (id) => api.kill(id),
};

// ---------- UI primitives ----------
const ANSI = /\x1b\[[0-9;?]*[A-Za-z]/g;
const TRACEBACK = /File "([^"]+)", line (\d+)/g;

ide.ui = {};

ide.ui.console = (host, { input = false, placeholder = '', onInput } = {}) => {
  host.classList.add('console-host');
  const out = el('pre', 'console');
  host.appendChild(out);
  let inp;
  if (input) {
    inp = el('input', 'console-in');
    inp.placeholder = placeholder;
    inp.onkeydown = (e) => {
      if (e.key !== 'Enter') return;
      const text = inp.value;
      inp.value = '';
      onInput?.(text);
    };
    host.appendChild(inp);
  }
  return {
    out,
    input: inp,
    append(text, cls) {
      text = text.replace(ANSI, '');
      const span = el('span', cls);
      let last = 0;
      for (const m of text.matchAll(TRACEBACK)) {
        span.append(text.slice(last, m.index));
        const a = el('a', null, m[0]);
        a.onclick = () => ide.openFile(m[1], { line: Number(m[2]) });
        span.append(a);
        last = m.index + m[0].length;
      }
      span.append(text.slice(last));
      const atBottom = out.scrollHeight - out.scrollTop - out.clientHeight < 40;
      out.appendChild(span);
      if (atBottom) out.scrollTop = out.scrollHeight;
    },
    clear: () => out.replaceChildren(),
    text: () => out.textContent,
  };
};

// Popup chooser used by search everywhere, find action, recent files, and prompts.
let popupState = null;
const fuzzyScore = (text, q) => {
  if (!q) return 1;
  const t = text.toLowerCase();
  if (t.startsWith(q)) return 4;
  if (t.includes(q)) return 3;
  let i = 0;
  for (const ch of t) if (ch === q[i]) i++;
  return i === q.length ? 1 : 0;
};

function renderPopup() {
  const s = popupState;
  const list = $('popupList');
  list.innerHTML = '';
  if (s.mode === 'prompt') {
    list.appendChild(el('div', 'popup-item hint', tr('{label} — Enter to confirm, Esc to cancel', { label: s.placeholder })));
    return;
  }
  const q = $('popupIn').value.trim().toLowerCase();
  const items = s.filter === false ? s.items
    : s.items.map((it) => [it, fuzzyScore(it.label, q) * 2 + (it.detail ? fuzzyScore(it.detail, q) && 1 : 0)])
      .filter(([, sc]) => sc > 0).sort((a, b) => b[1] - a[1]).map(([it]) => it);
  items.slice(0, 200).forEach((it, i) => {
    const row = el('div', 'popup-item' + (i === 0 ? ' active' : ''));
    if (it.icon) row.appendChild(el('span', 'icon', it.icon));
    row.appendChild(el('span', 'label', it.label));
    if (it.detail) row.appendChild(el('span', 'detail', it.detail));
    if (it.hint) row.appendChild(el('span', 'hint-right', it.hint));
    row.onmousedown = (e) => { e.preventDefault(); closePopup(it.value ?? it); };
    row._item = it;
    list.appendChild(row);
  });
  if (!items.length) list.appendChild(el('div', 'popup-item hint', tr('Nothing found')));
}

function closePopup(value = null) {
  if (!popupState) return;
  const { resolve } = popupState;
  popupState = null;
  $('popup').classList.add('hidden');
  resolve(value);
}

function openPopup(state) {
  if (popupState) closePopup();
  return new Promise((resolve) => {
    popupState = { ...state, resolve };
    $('popupIn').placeholder = state.placeholder || '';
    $('popupIn').value = state.initial || '';
    $('popup').classList.remove('hidden');
    $('popupIn').focus();
    if (state.mode === 'prompt') $('popupIn').select();
    renderPopup();
  });
}

// items: [{label, detail?, hint?, icon?, value?}] or an async function(query) returning that list
ide.ui.pick = ({ placeholder, items, initial }) => {
  if (typeof items === 'function') {
    const load = items;
    const p = openPopup({ placeholder, items: [], filter: false, initial });
    let seq = 0;
    const refresh = async () => {
      const my = ++seq;
      const res = await load($('popupIn').value);
      if (popupState && my === seq) { popupState.items = res; renderPopup(); }
    };
    popupState.onQuery = refresh;
    refresh();
    return p;
  }
  return openPopup({ placeholder, items, initial });
};
ide.ui.prompt = (placeholder, initial = '') => openPopup({ placeholder, mode: 'prompt', initial });

$('popupIn').oninput = () => (popupState?.onQuery ? popupState.onQuery() : popupState && renderPopup());
$('popupIn').onkeydown = (e) => {
  if (!popupState) return;
  if (e.key === 'Escape') { e.stopPropagation(); return closePopup(); }
  if (popupState.mode === 'prompt') { if (e.key === 'Enter') closePopup($('popupIn').value.trim() || null); return; }
  const rows = [...$('popupList').querySelectorAll('.popup-item:not(.hint)')];
  const i = rows.findIndex((r) => r.classList.contains('active'));
  if (e.key === 'ArrowDown' || e.key === 'ArrowUp') {
    e.preventDefault();
    rows[i]?.classList.remove('active');
    const next = rows[(i + (e.key === 'ArrowDown' ? 1 : -1) + rows.length) % rows.length];
    next?.classList.add('active');
    next?.scrollIntoView({ block: 'nearest' });
  } else if (e.key === 'Enter' && rows[i]) {
    e.preventDefault();
    closePopup(rows[i]._item.value ?? rows[i]._item);
  }
};
$('popupIn').onblur = () => setTimeout(() => document.activeElement !== $('popupIn') && closePopup(), 120);

// items: [{label, hint?, run, disabled?} | {separator: true}]
ide.ui.contextMenu = (x, y, items) => {
  const host = $('menuHost');
  host.innerHTML = '';
  const menu = el('div', 'context-menu');
  for (const it of items) {
    if (it.separator) { menu.appendChild(el('div', 'menu-sep')); continue; }
    const row = el('div', 'menu-item' + (it.disabled ? ' disabled' : ''));
    row.appendChild(el('span', null, it.label));
    if (it.hint) row.appendChild(el('span', 'hint-right', it.hint));
    row.onmousedown = (e) => { e.preventDefault(); if (it.disabled) return; host.innerHTML = ''; it.run(); };
    menu.appendChild(row);
  }
  host.appendChild(menu);
  const r = menu.getBoundingClientRect();
  menu.style.left = `${Math.min(x, innerWidth - r.width - 4)}px`;
  menu.style.top = `${Math.min(y, innerHeight - r.height - 4)}px`;
  const dismiss = (e) => {
    if (menu.contains(e.target)) return;
    host.innerHTML = '';
    removeEventListener('mousedown', dismiss, true);
  };
  setTimeout(() => addEventListener('mousedown', dismiss, true));
};

// buttons: [{label, primary?, run?(dialog) -> false keeps it open}]
ide.ui.dialog = ({ title, body, buttons = [{ label: tr('OK'), primary: true }], width = 520, onClose }) => {
  const backdrop = el('div', 'dialog-backdrop');
  const box = el('div', 'dialog');
  box.style.width = `${width}px`;
  const head = el('div', 'dialog-title', title);
  const content = el('div', 'dialog-body');
  if (typeof body === 'string') content.innerHTML = body; else if (body) content.appendChild(body);
  const foot = el('div', 'dialog-buttons');
  const dlg = {
    el: box,
    body: content,
    close() { backdrop.remove(); removeEventListener('keydown', onKey, true); onClose?.(); },
  };
  for (const b of buttons) {
    const btn = el('button', b.primary ? 'primary' : 'secondary', b.label);
    btn.onclick = async () => { if ((await b.run?.(dlg)) !== false) dlg.close(); };
    foot.appendChild(btn);
  }
  const onKey = (e) => {
    if (e.key === 'Escape') { e.stopPropagation(); dlg.close(); }
    if (e.key === 'Enter' && e.target.tagName !== 'TEXTAREA') { e.stopPropagation(); foot.querySelector('.primary')?.click(); }
  };
  addEventListener('keydown', onKey, true);
  box.append(head, content, foot);
  backdrop.appendChild(box);
  $('dialogHost').appendChild(backdrop);
  content.querySelector('input,select,textarea')?.focus();
  return dlg;
};

// ---------- actions & keymap ----------
const CODE_KEYS = { Slash: '/', Backslash: '\\', Minus: '-', Equal: '=', Comma: ',', Period: '.', Semicolon: ';',
  Quote: "'", BracketLeft: '[', BracketRight: ']', Backquote: '`', NumpadDivide: '/' };
const keyName = (e) => {
  const c = e.code || '';
  if (c.startsWith('Key')) return c.slice(3);
  if (c.startsWith('Digit')) return c.slice(5);
  if (CODE_KEYS[c]) return CODE_KEYS[c];
  return e.key.length === 1 ? e.key.toUpperCase() : e.key;
};
const comboOf = (e) => `${e.ctrlKey ? 'Ctrl+' : ''}${e.altKey ? 'Alt+' : ''}${e.shiftKey ? 'Shift+' : ''}${keyName(e)}`;
const normalizeKeys = (keys) => (Array.isArray(keys) ? keys : keys ? [keys] : []);

// {id, title, keys?: 'Ctrl+Shift+F' | [...], run, when?: () => bool}. Later registrations win on key clashes.
ide.registerAction = (action) => {
  ide.actions = ide.actions.filter((a) => a.id !== action.id);
  ide.actions.push({ ...action, keys: normalizeKeys(action.keys) });
  return action;
};
ide.runAction = (id) => ide.actions.find((a) => a.id === id)?.run();
ide.keysFor = (id) => ide.actions.find((a) => a.id === id)?.keys.join(', ') || '';

let lastShift = 0;
document.addEventListener('keydown', (e) => {
  if (popupState || $('dialogHost').childElementCount) return;
  if (e.key === 'Shift' && !e.ctrlKey && !e.altKey && !e.repeat) {
    const now = performance.now();
    if (now - lastShift < 350) { lastShift = 0; return fireCombo('Shift Shift', e); }
    lastShift = now;
    return;
  }
  if (!['Control', 'Alt', 'Shift', 'Meta'].includes(e.key)) lastShift = 0;
  fireCombo(comboOf(e), e);
}, true);

function fireCombo(combo, e) {
  for (let i = ide.actions.length - 1; i >= 0; i--) {
    const a = ide.actions[i];
    if (!a.keys.includes(combo) || (a.when && !a.when())) continue;
    e.preventDefault();
    e.stopPropagation();
    a.run();
    return;
  }
}

// ---------- toolbar & status bar ----------
const placeOrdered = (host, node, order) => {
  node.dataset.order = order;
  const before = [...host.children].find((c) => Number(c.dataset.order ?? 0) > order);
  host.insertBefore(node, before || null);
};
ide.registerToolbarItem = ({ side = 'right', order = 100, el: node }) => placeOrdered($(side === 'left' ? 'toolbarLeft' : 'toolbarRight'), node, order);
ide.registerStatusItem = ({ order = 100, el: node }) => placeOrdered($('statusItems'), node, order);
$('interpSelect').dataset.order = 50;
$('projectWidget').dataset.order = 0;

// ---------- tool windows ----------
const areas = {
  left: { panel: $('sidePanel'), splitter: $('sideSplitter'), body: $('sideBody'), actions: $('sideActions'), stripe: $('stripeTop'), active: null },
  bottom: { panel: $('bottom'), splitter: $('bottomSplitter'), body: $('bottomBody'), actions: $('bottomActions'), stripe: $('stripeBottom'), active: null },
};

function renderAreaActions(area) {
  area.actions.innerHTML = '';
  for (const a of area.active?.actionList || []) {
    const b = el('button', null, a.icon);
    b.title = a.title;
    b.onclick = a.run;
    area.actions.appendChild(b);
  }
}

function setAreaVisible(area, visible) {
  area.panel.classList.toggle('hidden', !visible);
  area.splitter.classList.toggle('hidden', !visible);
  for (const tw of ide.toolWindows.values()) {
    if (tw.area === area) tw.button.classList.toggle('active', visible && area.active === tw);
  }
}

// {id, title, icon, side: 'left'|'bottom', keys?, order?, mount(container, tw)} -> tw {show, hide, toggle, setActions, setBadge, isVisible}
ide.registerToolWindow = ({ id, title, icon, side = 'bottom', keys, order = 100, mount }) => {
  const area = areas[side];
  const container = el('div', 'tool');
  area.body.appendChild(container);
  const button = el('button', 'stripe-btn', icon);
  button.title = `${title}${keys ? ` (${normalizeKeys(keys).join(', ')})` : ''}`;
  placeOrdered(area.stripe, button, order);
  let tab;
  if (side === 'bottom') {
    tab = el('button', 'bottom-tab');
    tab.appendChild(el('span', null, title));
    tab.appendChild(el('span', 'badge'));
    placeOrdered($('bottomTabs'), tab, order);
  }
  const tw = {
    id, title, area, container, button, actionList: [],
    isVisible: () => !area.panel.classList.contains('hidden') && area.active === tw,
    show() {
      area.active = tw;
      area.picked = true;
      for (const other of ide.toolWindows.values()) {
        if (other.area !== area) continue;
        other.container.classList.toggle('active', other === tw);
        other.tab?.classList.toggle('active', other === tw);
      }
      if (side === 'left') $('sideTitle').textContent = title;
      setAreaVisible(area, true);
      renderAreaActions(area);
      ide.emit('toolWindowShown', id);
      container.querySelector('input.console-in:not([disabled]), input:not([disabled])')?.focus();
    },
    hide() { if (area.active === tw) { setAreaVisible(area, false); ide.editor?.focus(); } },
    toggle() { tw.isVisible() ? tw.hide() : tw.show(); },
    setActions(list) { tw.actionList = list; if (area.active === tw) renderAreaActions(area); },
    setBadge(text) { if (tab) tab.querySelector('.badge').textContent = text || ''; button.dataset.badge = text || ''; },
    tab,
  };
  button.onclick = tw.toggle;
  if (tab) tab.onclick = tw.show;
  ide.toolWindows.set(id, tw);
  if (keys) ide.registerAction({ id: `Activate${id}ToolWindow`, title: tr('Tool Window: {title}', { title }), keys, run: tw.toggle });
  mount?.(container, tw);
  // Until something is shown explicitly, the default window of an area is the one with the lowest order
  // (features load alphabetically, so registration order is not meaningful).
  tw.order = order;
  if (!area.active || (!area.picked && order < area.active.order)) {
    area.active?.container.classList.remove('active');
    area.active?.tab?.classList.remove('active');
    area.active = tw; container.classList.add('active'); tab?.classList.add('active'); if (side === 'left') $('sideTitle').textContent = title; renderAreaActions(area);
  }
  return tw;
};
$('hideBottomBtn').onclick = () => areas.bottom.active?.hide();

// ---------- problems ----------
const problemStore = new Map(); // source -> Map(pathLower -> {path, items})
const SEVERITY = () => ({ error: ide.monaco.MarkerSeverity.Error, warning: ide.monaco.MarkerSeverity.Warning, info: ide.monaco.MarkerSeverity.Info });

function applyMarkers(tab) {
  if (!tab?.model) return;
  for (const [source, files] of problemStore) {
    const entry = files.get(tab.path.toLowerCase());
    ide.monaco.editor.setModelMarkers(tab.model, source, (entry?.items || []).map((p) => ({
      severity: SEVERITY()[p.severity || 'error'], message: p.msg, source,
      startLineNumber: p.line, startColumn: p.col || 1,
      endLineNumber: p.endLine || p.line, endColumn: Math.max(p.endCol || 0, (p.col || 1) + 1),
    })));
  }
}

ide.problems = {
  // items: [{line, col, endLine?, endCol?, msg, severity: 'error'|'warning'|'info'}]
  set(source, path, items) {
    if (!problemStore.has(source)) problemStore.set(source, new Map());
    const files = problemStore.get(source);
    if (items?.length) files.set(path.toLowerCase(), { path, items }); else files.delete(path.toLowerCase());
    const tab = ide.findTab(path);
    if (tab) applyMarkers(tab);
    ide.emit('problemsChanged');
  },
  clear(source) {
    const files = problemStore.get(source);
    if (!files) return;
    problemStore.delete(source);
    for (const { path } of files.values()) {
      const tab = ide.findTab(path);
      if (tab?.model) ide.monaco.editor.setModelMarkers(tab.model, source, []);
    }
    ide.emit('problemsChanged');
  },
  all() {
    const out = [];
    for (const [source, files] of problemStore) for (const { path, items } of files.values()) for (const p of items) out.push({ ...p, path, source });
    return out;
  },
};

// ---------- tabs ----------
const languageFor = (p) => LANG_BY_EXT[p.split('.').pop().toLowerCase()] || 'plaintext';
ide.findTab = (path) => ide.tabs.find((t) => samePath(t.path, path));
ide.activeTab = () => ide.findTab(ide.active);
ide.isDirty = (t) => t.kind === 'file' && t.model.getAlternativeVersionId() !== t.savedVersion;

function showSurface(tab) {
  $('editor').classList.toggle('hidden', !tab || tab.kind !== 'file');
  for (const t of ide.tabs) t.host?.classList.toggle('hidden', t !== tab);
}

function activate(tab) {
  ide.active = tab?.path || null;
  showSurface(tab);
  if (tab?.kind === 'file') ide.editor.setModel(tab.model);
  else ide.editor.setModel(null);
  $('statusPath').textContent = tab ? ide.util.rel(tab.path) : '';
  renderTabs();
  ide.emit('activeTabChanged', tab || null);
}

// opts: {line?, col?, focus = true}. Returns the tab.
ide.openFile = async (path, opts = {}) => {
  let tab = ide.findTab(path);
  if (!tab) {
    let text;
    try { text = await ide.api.read(path); } catch (e) { alert(e.message); return null; }
    tab = ide.findTab(path);
    if (!tab) {
      const uri = ide.monaco.Uri.file(path);
      const model = ide.monaco.editor.getModel(uri) || ide.monaco.editor.createModel(text, languageFor(path), uri);
      tab = { kind: 'file', path, title: basename(path), model, savedVersion: model.getAlternativeVersionId() };
      ide.tabs.push(tab);
      applyMarkers(tab);
      ide.emit('fileOpened', tab);
    }
  }
  activate(tab);
  if (opts.line) {
    const pos = { lineNumber: opts.line, column: opts.col || 1 };
    ide.editor.setPosition(pos);
    ide.editor.revealPositionInCenterIfOutsideViewport(pos);
  }
  if (opts.focus !== false) ide.editor.focus();
  return tab;
};

// {id, title, icon?, mount(host, tab), onClose?()} -> tab; reopening an existing id just activates it.
ide.openCustomTab = ({ id, title, icon = '◆', mount, onClose }) => {
  let tab = ide.findTab(id);
  if (!tab) {
    const host = el('div', 'custom-tab hidden');
    $('customHost').appendChild(host);
    tab = { kind: 'custom', path: id, title, icon, host, onClose };
    ide.tabs.push(tab);
    mount(host, tab);
  }
  activate(tab);
  return tab;
};

function renderTabs() {
  const bar = $('tabs');
  bar.innerHTML = '';
  for (const t of ide.tabs) {
    const node = el('div', 'tab' + (samePath(t.path, ide.active) ? ' active' : ''));
    node.title = t.path;
    node.appendChild(el('span', 'tab-icon', t.kind === 'custom' ? t.icon : t.path.endsWith('.py') ? '🐍' : '📄'));
    node.appendChild(el('span', 'name', t.title));
    if (ide.isDirty(t)) node.appendChild(el('span', 'dirty', '●'));
    const close = el('button', 'close', '×');
    node.appendChild(close);
    node.onclick = () => (t.kind === 'file' ? ide.openFile(t.path) : activate(t));
    node.onauxclick = (e) => e.button === 1 && ide.closeTab(t.path);
    node.oncontextmenu = (e) => {
      e.preventDefault();
      ide.ui.contextMenu(e.clientX, e.clientY, [
        { label: tr('Close'), hint: 'Ctrl+F4', run: () => ide.closeTab(t.path) },
        { label: tr('Close Other Tabs'), run: () => ide.tabs.filter((o) => o !== t).forEach((o) => ide.closeTab(o.path)) },
        { label: tr('Close All Tabs'), run: () => [...ide.tabs].forEach((o) => ide.closeTab(o.path)) },
      ]);
    };
    close.onclick = (e) => { e.stopPropagation(); ide.closeTab(t.path); };
    bar.appendChild(node);
  }
  bar.querySelector('.tab.active')?.scrollIntoView({ block: 'nearest', inline: 'nearest' });
}
ide.renderTabs = renderTabs;

ide.closeTab = (path, force) => {
  const i = ide.tabs.findIndex((t) => samePath(t.path, path));
  if (i < 0) return;
  const tab = ide.tabs[i];
  if (!force && ide.isDirty(tab) && !confirm(tr('{name} has unsaved changes. Close anyway?', { name: tab.title }))) return;
  ide.tabs.splice(i, 1);
  if (tab.kind === 'file') tab.model.dispose();
  else { tab.onClose?.(); tab.host.remove(); }
  ide.emit('fileClosed', tab.path);
  if (samePath(ide.active, path)) {
    const next = ide.tabs[Math.min(i, ide.tabs.length - 1)];
    if (next) (next.kind === 'file' ? ide.openFile(next.path) : activate(next));
    else activate(null);
  } else renderTabs();
};

ide.saveTab = async (tab) => {
  if (!ide.isDirty(tab)) return;
  ide.emit('beforeSave', tab);
  await ide.api.write(tab.path, tab.model.getValue());
  tab.savedVersion = tab.model.getAlternativeVersionId();
  ide.emit('fileSaved', tab);
};
ide.saveAll = async () => {
  await Promise.all(ide.tabs.filter((t) => t.kind === 'file').map(ide.saveTab));
  renderTabs();
};

// Reloads open tabs whose file changed on disk (after formatters, git checkout, replace-in-files...).
ide.reloadFromDisk = async (paths) => {
  for (const tab of ide.tabs.filter((t) => t.kind === 'file' && (!paths || paths.some((p) => samePath(p, t.path))))) {
    if (ide.isDirty(tab)) continue;
    let text;
    try { text = await ide.api.read(tab.path); } catch { continue; }
    if (text === tab.model.getValue()) continue;
    tab.model.pushEditOperations([], [{ range: tab.model.getFullModelRange(), text }], () => null);
    tab.savedVersion = tab.model.getAlternativeVersionId();
  }
  renderTabs();
};

function cycleTab(dir) {
  if (!ide.tabs.length) return;
  const i = ide.tabs.findIndex((t) => samePath(t.path, ide.active));
  const t = ide.tabs[(i + dir + ide.tabs.length) % ide.tabs.length];
  t.kind === 'file' ? ide.openFile(t.path) : activate(t);
}

// ---------- project tree ----------
const expanded = new Set();
const treeDecorators = [];
const treeActions = [];
let selected = null;

ide.registerTreeDecorator = (fn) => { treeDecorators.push(fn); };
// {title, when?(entry), run(entry)}; entry = {name, path, dir}
ide.registerTreeAction = (action) => { treeActions.push(action); };
ide.selectedTreeEntry = () => selected;

async function renderTree() {
  const tree = $('tree');
  if (!tree || !ide.root) return;
  const frag = document.createDocumentFragment();
  const addNode = async (entry, depth) => {
    const node = el('div', 'node' + (selected && samePath(entry.path, selected.path) ? ' selected' : ''));
    node.style.paddingLeft = `${depth * 16 + 4}px`;
    const open = expanded.has(entry.path.toLowerCase());
    const ext = entry.name.split('.').pop();
    node.appendChild(el('span', 'arrow', entry.dir ? (open ? '▾' : '▸') : ''));
    node.appendChild(el('span', 'icon ' + (entry.dir ? 'dir' : ext === 'py' ? 'py' : 'file'), entry.dir ? (open ? '📂' : '📁') : ext === 'py' ? '🐍' : '📄'));
    const name = el('span', 'name', entry.name);
    node.appendChild(name);
    for (const deco of treeDecorators) {
      const d = deco(entry);
      if (d?.color) name.style.color = d.color;
      if (d?.badge) node.appendChild(el('span', 'tree-badge', d.badge));
    }
    node.onclick = () => {
      selected = entry;
      if (entry.dir) {
        const k = entry.path.toLowerCase();
        expanded.has(k) ? expanded.delete(k) : expanded.add(k);
        renderTree();
      } else {
        tree.querySelectorAll('.selected').forEach((n) => n.classList.remove('selected'));
        node.classList.add('selected');
        ide.openFile(entry.path);
      }
    };
    node.oncontextmenu = (e) => {
      e.preventDefault();
      selected = entry;
      tree.querySelectorAll('.selected').forEach((n) => n.classList.remove('selected'));
      node.classList.add('selected');
      showTreeMenu(entry, e.clientX, e.clientY);
    };
    frag.appendChild(node);
    if (entry.dir && open) {
      let children = [];
      try { children = await ide.api.list(entry.path); } catch {}
      for (const child of children) await addNode(child, depth + 1);
    }
  };
  await addNode({ name: basename(ide.root), path: ide.root, dir: true }, 0);
  tree.replaceChildren(frag);
  ide.emit('treeRefreshed');
}
ide.refreshTree = renderTree;

ide.revealInTree = async (path) => {
  let d = dirname(path);
  while (d && d.length >= (ide.root || '').length) { expanded.add(d.toLowerCase()); d = dirname(d); }
  selected = { name: basename(path), path, dir: false };
  await renderTree();
  $('tree').querySelector('.selected')?.scrollIntoView({ block: 'nearest' });
};

const selectedDir = () => (!selected ? ide.root : selected.dir ? selected.path : dirname(selected.path));

async function createEntry(isDir) {
  if (!ide.root) return;
  const name = await ide.ui.prompt(isDir ? tr('New directory name') : tr('New Python file name'), isDir ? '' : 'main.py');
  if (!name) return;
  const target = joinPath(selectedDir(), !isDir && !name.includes('.') ? `${name}.py` : name);
  try {
    await ide.api.create(target, isDir);
    expanded.add(dirname(target).toLowerCase());
    await renderTree();
    ide.emit('filesChanged', { created: [target] });
    if (!isDir) ide.openFile(target);
  } catch (e) { alert(e.message); }
}

async function renameEntry(entry) {
  const name = await ide.ui.prompt(tr('New name'), entry.name);
  if (!name || name === entry.name) return;
  const to = joinPath(dirname(entry.path), name);
  try { await ide.api.rename(entry.path, to); } catch (e) { return alert(e.message); }
  for (const t of ide.tabs.filter((t) => t.kind === 'file' && isUnder(t.path, entry.path))) {
    ide.closeTab(t.path, true);
  }
  renderTree();
  ide.emit('filesChanged', { renamed: [[entry.path, to]] });
}

async function deleteEntry(entry) {
  if (!confirm(tr('Move {name} to the Recycle Bin?', { name: entry.name }))) return;
  await ide.api.trash(entry.path);
  ide.tabs.filter((t) => t.path && isUnder(t.path, entry.path)).forEach((t) => ide.closeTab(t.path, true));
  renderTree();
  ide.emit('filesChanged', { deleted: [entry.path] });
}

function showTreeMenu(entry, x, y) {
  const extra = treeActions.filter((a) => !a.when || a.when(entry)).map((a) => ({ label: a.title, hint: a.hint, run: () => a.run(entry) }));
  ide.ui.contextMenu(x, y, [
    { label: tr('New Python File'), hint: 'Alt+Insert', run: () => createEntry(false) },
    { label: tr('New Directory'), run: () => createEntry(true) },
    { separator: true },
    ...(extra.length ? [...extra, { separator: true }] : []),
    { label: tr('Rename…'), hint: 'Shift+F6', run: () => renameEntry(entry), disabled: samePath(entry.path, ide.root) },
    { label: tr('Delete'), hint: 'Delete', run: () => deleteEntry(entry), disabled: samePath(entry.path, ide.root) },
  ]);
}

ide.registerToolWindow({
  id: 'Project', title: tr('Project'), icon: '▤', side: 'left', keys: 'Alt+1', order: 0,
  mount(container, tw) {
    const tree = el('div');
    tree.id = 'tree';
    container.appendChild(tree);
    tw.setActions([
      { icon: '＋', title: tr('New Python File'), run: () => createEntry(false) },
      { icon: '▣', title: tr('New Directory'), run: () => createEntry(true) },
      { icon: '⟳', title: tr('Refresh'), run: renderTree },
    ]);
  },
});

// ---------- interpreters ----------
ide.currentInterp = () => ide.interps[$('interpSelect').selectedIndex] || null;
ide.reloadInterpreters = async () => {
  ide.interps = await ide.api.interpreters(ide.root, ide.settings.get('interpreters.extra', []));
  const sel = $('interpSelect');
  sel.innerHTML = '';
  for (const it of ide.interps) sel.add(new Option(it.label));
  if (!ide.interps.length) sel.add(new Option(tr('<No interpreter>')));
  const preferred = ide.settings.get(`interpreter.${ide.root}`);
  const idx = ide.interps.findIndex((i) => samePath(i.executable, preferred));
  if (idx >= 0) sel.selectedIndex = idx;
  $('statusInterp').textContent = ide.currentInterp()?.label || tr('No interpreter');
  ide.emit('interpreterChanged', ide.currentInterp());
};
$('interpSelect').onchange = () => {
  const it = ide.currentInterp();
  $('statusInterp').textContent = it?.label || '';
  if (it && ide.root) ide.settings.set(`interpreter.${ide.root}`, it.executable);
  ide.emit('interpreterChanged', it);
};

// ---------- project ----------
ide.openProject = async (dir) => {
  for (const t of [...ide.tabs]) ide.closeTab(t.path, true);
  ide.root = dir;
  expanded.clear();
  expanded.add(dir.toLowerCase());
  selected = null;
  $('projectWidget').textContent = `${basename(dir)} ▾`;
  document.title = `${basename(dir)} - PyIDE`;
  $('welcome').classList.add('hidden');
  await renderTree();
  await ide.reloadInterpreters();
  try { localStorage.setItem('lastProject', dir); } catch {}
  ide.emit('projectOpened', dir);
};

async function pickFolder() {
  const dir = await ide.api.openFolder();
  if (dir) ide.openProject(dir);
}

// ---------- splitters ----------
document.querySelectorAll('.splitter').forEach((s) => {
  s.onmousedown = (down) => {
    const target = $(s.dataset.target);
    const vertical = s.classList.contains('v');
    const start = vertical ? down.clientX : down.clientY;
    const size = vertical ? target.offsetWidth : target.offsetHeight;
    const move = (e) => {
      const delta = (vertical ? e.clientX : e.clientY) - start;
      if (vertical) target.style.width = `${Math.max(140, size + delta)}px`;
      else target.style.height = `${Math.max(80, size - delta)}px`;
    };
    const up = () => { removeEventListener('mousemove', move); removeEventListener('mouseup', up); };
    addEventListener('mousemove', move);
    addEventListener('mouseup', up);
  };
});

// ---------- core actions (PyCharm $default keymap, extracted with REA) ----------
async function gotoFile() {
  if (!ide.root) return;
  const files = await ide.api.walk(ide.root);
  const path = await ide.ui.pick({
    placeholder: tr('Search files'),
    items: files.map((p) => ({ label: basename(p), detail: ide.util.rel(dirname(p)), icon: p.endsWith('.py') ? '🐍' : '📄', value: p })),
  });
  if (path) ide.openFile(path);
}

async function findAction() {
  const action = await ide.ui.pick({
    placeholder: tr('Search actions'),
    items: ide.actions.filter((a) => a.title).map((a) => ({ label: a.title, hint: a.keys.join(', '), value: a })),
  });
  action?.run();
}

const inEditor = () => ide.editor?.hasTextFocus();
const editorAction = (id) => () => ide.editor?.trigger('keymap', id, null);
[
  { id: 'SaveAll', title: tr('Save All'), keys: 'Ctrl+S', run: ide.saveAll },
  { id: 'OpenProject', title: tr('Open Folder…'), keys: 'Ctrl+O', run: pickFolder },
  { id: 'GotoFile', title: tr('Go to File…'), keys: ['Ctrl+Shift+N', 'Shift Shift'], run: gotoFile },
  { id: 'GotoAction', title: tr('Find Action…'), keys: 'Ctrl+Shift+A', run: findAction },
  { id: 'CloseContent', title: tr('Close Tab'), keys: 'Ctrl+F4', run: () => ide.active && ide.closeTab(ide.active) },
  { id: 'PreviousTab', title: tr('Previous Tab'), keys: 'Alt+ArrowLeft', run: () => cycleTab(-1) },
  { id: 'NextTab', title: tr('Next Tab'), keys: 'Alt+ArrowRight', run: () => cycleTab(1) },
  { id: 'NewPythonFile', title: tr('New Python File'), keys: 'Alt+Insert', run: () => createEntry(false) },
  { id: 'HideBottom', title: tr('Hide Active Tool Window'), keys: 'Shift+Escape', run: () => areas.bottom.active?.hide() },
  { id: 'FocusEditor', keys: 'Escape', when: () => !inEditor() && !document.activeElement?.closest('#editor') && !!ide.editor?.getModel(), run: () => ide.editor.focus() },
  { id: 'EditorDuplicate', title: tr('Duplicate Line'), keys: 'Ctrl+D', when: inEditor, run: editorAction('editor.action.copyLinesDownAction') },
  { id: 'EditorDeleteLine', title: tr('Delete Line'), keys: 'Ctrl+Y', when: inEditor, run: editorAction('editor.action.deleteLines') },
  { id: 'CommentByLineComment', title: tr('Comment with Line Comment'), keys: 'Ctrl+/', when: inEditor, run: editorAction('editor.action.commentLine') },
  { id: 'GotoLine', title: tr('Go to Line…'), keys: 'Ctrl+G', when: inEditor, run: editorAction('editor.action.gotoLine') },
  { id: 'Find', title: tr('Find'), keys: 'Ctrl+F', when: inEditor, run: editorAction('actions.find') },
  { id: 'Replace', title: tr('Replace'), keys: 'Ctrl+R', when: inEditor, run: editorAction('editor.action.startFindReplaceAction') },
  { id: 'EditorSelectWord', title: tr('Extend Selection'), keys: 'Ctrl+W', when: inEditor, run: editorAction('editor.action.smartSelect.expand') },
  { id: 'EditorUnSelectWord', title: tr('Shrink Selection'), keys: 'Ctrl+Shift+W', when: inEditor, run: editorAction('editor.action.smartSelect.shrink') },
  { id: 'MoveLineUp', title: tr('Move Line Up'), keys: 'Alt+Shift+ArrowUp', when: inEditor, run: editorAction('editor.action.moveLinesUpAction') },
  { id: 'MoveLineDown', title: tr('Move Line Down'), keys: 'Alt+Shift+ArrowDown', when: inEditor, run: editorAction('editor.action.moveLinesDownAction') },
  { id: 'CollapseRegion', title: tr('Collapse'), keys: 'Ctrl+-', when: inEditor, run: editorAction('editor.fold') },
  { id: 'ExpandRegion', title: tr('Expand'), keys: 'Ctrl+=', when: inEditor, run: editorAction('editor.unfold') },
].forEach(ide.registerAction);

$('projectWidget').textContent = `${tr('No project')} ▾`;
$('projectWidget').onclick = pickFolder;
$('welcomeOpen').onclick = pickFolder;

// ---------- boot ----------
ide.api = window.api;
// Monaco cancels in-flight provider requests (e.g. word highlight) when the model switches and leaves the
// rejection unhandled; Monaco itself treats these as non-errors.
addEventListener('unhandledrejection', (e) => { if (e.reason?.name === 'Canceled' && e.reason?.message === 'Canceled') e.preventDefault(); });

async function loadFeatures() {
  for (const p of await ide.api.invoke('core:features')) {
    if (p.css) {
      const link = el('link');
      link.rel = 'stylesheet';
      link.href = p.css;
      document.head.appendChild(link);
    }
    await new Promise((resolve) => {
      const s = el('script');
      s.src = p.script;
      s.onload = resolve;
      s.onerror = () => { console.error(`plugin ${p.id} failed to load`); resolve(); };
      document.body.appendChild(s);
    });
  }
}

ide.restart = () => ide.api.relaunch();

require.config({ paths: { vs: '../node_modules/monaco-editor/min/vs' } });
// Monaco's default blob worker cannot importScripts() a file:// URL (uncaught ErrorEvent); load the worker script directly.
window.MonacoEnvironment = { getWorkerUrl: () => new URL('../node_modules/monaco-editor/min/vs/base/worker/workerMain.js', location.href).href };
// Monaco's own UI strings (find widget, context menu, command palette) come from its NLS bundle for the locale.
const monacoNls = i18n.locale === 'en' ? [] : [`vs/nls.messages.${i18n.locale}`];
require(monacoNls, () => require(['vs/editor/editor.main'], async () => {
  const monaco = (ide.monaco = window.monaco);
  monaco.languages.setMonarchTokensProvider('python', PYTHON_GRAMMAR);
  monaco.languages.setLanguageConfiguration('python', {
    comments: { lineComment: '#' },
    brackets: [['{', '}'], ['[', ']'], ['(', ')']],
    autoClosingPairs: [{ open: '{', close: '}' }, { open: '[', close: ']' }, { open: '(', close: ')' },
      { open: '"', close: '"', notIn: ['string'] }, { open: "'", close: "'", notIn: ['string', 'comment'] }],
    onEnterRules: [{ beforeText: /:\s*(#.*)?$/, action: { indentAction: monaco.languages.IndentAction.Indent } }],
    indentationRules: { increaseIndentPattern: /^\s*.*:\s*(#.*)?$/, decreaseIndentPattern: /^\s*(return|pass|break|continue|raise)\b.*$/ },
  });
  monaco.languages.registerCompletionItemProvider('python', { provideCompletionItems: pythonBasicCompletions(monaco) });
  monaco.editor.defineTheme('pycharm-dark', PYCHARM_DARK);

  ide.editor = monaco.editor.create($('editor'), {
    theme: 'pycharm-dark',
    fontFamily: "'JetBrains Mono', Consolas, monospace",
    fontSize: 14,
    lineHeight: 22,
    minimap: { enabled: false },
    automaticLayout: true,
    tabSize: 4,
    insertSpaces: true,
    rulers: [120],
    glyphMargin: true,
    scrollBeyondLastLine: false,
    cursorBlinking: 'solid',
    bracketPairColorization: { enabled: false },
    fixedOverflowWidgets: true,
  });
  ide.editor.onDidChangeCursorPosition((e) => ($('statusPos').textContent = `${e.position.lineNumber}:${e.position.column}`));
  ide.editor.onDidChangeModelContent(() => renderTabs());
  showSurface(null);

  await loadFeatures();
  ide.emit('ready');

  const last = new URLSearchParams(location.search).get('open') || (() => { try { return localStorage.getItem('lastProject'); } catch { return null; } })();
  if (last && await ide.api.exists(last)) await ide.openProject(last);
  else await ide.reloadInterpreters();
  window.__ideReady = true;
}));
