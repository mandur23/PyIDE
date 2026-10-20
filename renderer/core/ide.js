// PyIDE core: editor, tabs, project tree, and the registries features plug into (see FEATURES.md).
const $ = (id) => document.getElementById(id);
const el = (tag, cls, text) => {
  const n = document.createElement(tag);
  if (cls) n.className = cls;
  if (text !== undefined) n.textContent = text;
  return n;
};

const basename = (p) => p.split(/[\\/]/).pop();

// ResizeObserver with its work moved to the next animation frame, and skipped while the size stays the same. A callback
// that changes layout (a redraw, a terminal fit, a scrollbar appearing) then cannot re-trigger itself within the same
// frame, which the browser reports as "ResizeObserver loop completed with undelivered notifications".
function observeSize(target, fn) {
  let frame = 0;
  let last = '';
  const ro = new ResizeObserver((entries) => {
    const r = entries[entries.length - 1].contentRect;
    const size = `${Math.round(r.width)}x${Math.round(r.height)}`;
    if (size === last) return;
    last = size;
    cancelAnimationFrame(frame);
    frame = requestAnimationFrame(() => fn(r));
  });
  ro.observe(target);
  return { disconnect: () => { cancelAnimationFrame(frame); ro.disconnect(); } };
}
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

const ide = (window.ide = {
  t: tr,
  // The IDE log (<userData>/logs/pyide.log): ide.log.info(msg), or ide.logger('#my-plugin').warn(msg).
  log: ideDiagnostics.logger('#renderer'),
  logger: ideDiagnostics.logger,
  // A detached window ("Open in New Window") shows only editors; see editors.js.
  detached: new URLSearchParams(location.search).has('detached'),
  root: null,
  monaco: null,
  editor: null,
  tabs: [],
  active: null,
  interps: [],
  actions: [],
  toolWindows: new Map(),
  util: { $, el, basename, dirname, joinPath, samePath, isUnder, observeSize, rel: (p) => (ide.root && p.toLowerCase().startsWith(ide.root.toLowerCase()) ? p.slice(ide.root.length + 1) : p) },
});

if (ide.detached) document.body.classList.add('detached');

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
// Persisted by the main process (userData/settings.json). The changes made in one task are written together right
// after it, synchronously, and pending changes are written before the window unloads or the app restarts.
const settingsCache = window.__initialSettings || {};
// settings.json is the user's file (hand-edited, written by another version): a value of another kind than the
// caller's fallback reads as the fallback, so a list read as a list never meets a number. Number fallbacks are
// left alone (their readers convert), and so are recent projects without a path string, which are dropped here.
const kindOf = (v) => (Array.isArray(v) ? 'array' : v === null ? 'null' : typeof v);
if (Array.isArray(settingsCache.recentProjects)) settingsCache.recentProjects = settingsCache.recentProjects.filter((p) => typeof p?.path === 'string' && p.path);
let settingsDirty = false;
const flushSettings = () => {
  if (!settingsDirty) return;
  settingsDirty = false;
  // The main process could not write the file (it was locked, the disk full): keep the changes pending and retry.
  if (api.saveSettingsSync(settingsCache) === false) {
    settingsDirty = true;
    setTimeout(flushSettings, 2000);
  }
};
// pagehide comes after every beforeunload listener, so changes those listeners make are written too.
addEventListener('beforeunload', flushSettings);
addEventListener('pagehide', flushSettings);
ide.settings = {
  get: (key, fallback) => {
    if (!(key in settingsCache)) return fallback;
    const v = settingsCache[key];
    return fallback == null || typeof fallback === 'number' || kindOf(v) === kindOf(fallback) ? v : fallback;
  },
  set(key, value) {
    settingsCache[key] = value;
    if (!settingsDirty) {
      settingsDirty = true;
      setTimeout(flushSettings);
    }
    ide.emit('settingsChanged', key, value);
  },
  all: () => ({ ...settingsCache }),
  flush: flushSettings,
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
// Frames from code without a file ("<string>", "<frozen runpy>", "<stdin>") are not links.
const TRACEBACK = /File "([^"<][^"]*)", line (\d+)/g;

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
        a.onclick = () => ide.openFile(ide.toLocalPath(m[1]), { line: Number(m[2]) });
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

// Keyboard for a tool window's list or tree of rows, as in PyCharm: the list takes focus, Up/Down/Home/End move the
// selection over the shown rows matching `rows`, Enter opens the selected one, Right expands it (or enters it when it is
// open) and Left collapses it (or goes to its parent). The plugin says what its rows mean: selected() -> row, select(row),
// open(row) (a click by default), and for a tree expanded(row) -> true | false | null (a leaf), toggle(row) (a click) and
// parent(row, rows) (by data-depth). select and toggle may redraw the rows: the row with the same id(row) (data-key) is
// looked up again.
const rowAbove = (row, list) => {
  const depth = Number(row.dataset.depth);
  for (let j = list.indexOf(row) - 1; depth > 0 && j >= 0; j--) if (Number(list[j].dataset.depth || 0) < depth) return list[j];
  return null;
};
ide.ui.listKeys = (host, { rows, selected, select, open = (row) => row.click(), expanded = () => null, toggle = (row) => row.click(),
  parent = rowAbove, id = (row) => row.dataset.key ?? null }) => {
  const shownRows = () => [...host.querySelectorAll(rows)].filter((r) => r.getClientRects().length);
  selected ||= () => shownRows().find((r) => r.classList.contains('selected')) || null;
  select ||= (row) => {
    for (const r of host.querySelectorAll(rows)) r.classList.toggle('selected', r === row);
  };
  const again = (key) => key != null && shownRows().find((r) => id(r) === key);
  const go = (row) => {
    if (!row) return;
    const key = id(row);
    select(row);
    (again(key) || selected() || row).scrollIntoView({ block: 'nearest' });
  };
  host.tabIndex = 0;
  host.addEventListener('keydown', (e) => {
    if (e.ctrlKey || e.altKey || e.metaKey || e.target !== host) return;
    const list = shownRows();
    const cur = selected();
    const i = list.indexOf(cur);
    const state = i === -1 ? null : expanded(cur);
    const keys = {
      ArrowDown: () => go(list[Math.min(i + 1, list.length - 1)]),
      ArrowUp: () => go(list[Math.max(i - 1, 0)]),
      Home: () => go(list[0]),
      End: () => go(list[list.length - 1]),
      Enter: () => i !== -1 && open(cur),
      ArrowRight: () => {
        if (state === false) { const key = id(cur); toggle(cur); go(again(key)); }
        else if (state === true && list[i + 1] && parent(list[i + 1], list) === cur) go(list[i + 1]);
      },
      ArrowLeft: () => {
        if (state === true) { const key = id(cur); toggle(cur); go(again(key)); }
        else if (i !== -1) go(parent(cur, list));
      },
    };
    if (!keys[e.key] || !list.length) return;
    e.preventDefault();
    e.stopPropagation();
    keys[e.key]();
  });
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
    if (it.icon) row.appendChild(typeof it.icon === 'string' ? el('span', 'icon', it.icon) : Object.assign(it.icon.cloneNode(true), { className: `${it.icon.className} icon` }));
    row.appendChild(el('span', 'label', it.label));
    if (it.detail) row.appendChild(el('span', 'detail', it.detail));
    if (it.hint) row.appendChild(el('span', 'hint-right', it.hint));
    row.onmousedown = (e) => { e.preventDefault(); closePopup(it.value ?? it); };
    row._item = it;
    list.appendChild(row);
  });
  if (!items.length) list.appendChild(el('div', 'popup-item hint', tr('Nothing found')));
}

// Where the keyboard goes when a popup or dialog closes: back to the element that had it if it is still shown, else the
// editor; never left on the closed popup's hidden input, where keys would go nowhere.
const focusBack = (prev) => {
  if (prev?.isConnected && prev !== document.body && prev.getClientRects().length) prev.focus();
  else ide.editor?.focus();
};

function closePopup(value = null) {
  if (!popupState) return;
  const { resolve, prevFocus } = popupState;
  popupState = null;
  $('popup').classList.add('hidden');
  if (document.activeElement === $('popupIn')) focusBack(prevFocus);
  resolve(value);
}

function openPopup(state) {
  const prevFocus = popupState ? popupState.prevFocus : document.activeElement;
  if (popupState) closePopup();
  return new Promise((resolve) => {
    popupState = { ...state, resolve, prevFocus };
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
  // preventDefault: the Enter must not also reach the editor that gets the keyboard back.
  if (popupState.mode === 'prompt') { if (e.key === 'Enter') { e.preventDefault(); closePopup($('popupIn').value.trim() || null); } return; }
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

// Menus: items are [{label, hint?, icon?, checked?, disabled?, run?, submenu?: items | () => items} | {separator: true}].
// Submenus open on hover or Right; Up/Down move, Enter runs, Left closes a submenu, Esc closes the menu.
const menuStack = [];
let menuCleanup = null;

function closeMenus(level = 0) {
  while (menuStack.length > level) menuStack.pop().el.remove();
  if (!menuStack.length && menuCleanup) { menuCleanup(); menuCleanup = null; }
}
ide.ui.closeMenus = () => closeMenus(0);
// A menu removed from the page by other code counts as closed (and its key handlers are dropped).
function menusOpen() {
  if (menuStack.length && !menuStack[0].el.isConnected) closeMenus(0);
  return menuStack.length > 0;
}

function setActiveRow(level, row) {
  const m = menuStack[level];
  if (!m) return;
  m.el.querySelectorAll('.menu-item.active').forEach((n) => n.classList.remove('active'));
  if (row) { row.classList.add('active'); row.scrollIntoView({ block: 'nearest' }); }
  m.active = row || null;
}

function openSubmenu(level, row) {
  closeMenus(level + 1);
  const items = typeof row._item.submenu === 'function' ? row._item.submenu() : row._item.submenu;
  const r = row.getBoundingClientRect();
  showMenu(r.right - 2, r.top - 5, items, level + 1, r.left);
}

function activate(level, row) {
  const it = row?._item;
  if (!it || it.disabled) return;
  if (it.submenu) { openSubmenu(level, row); setActiveRow(level + 1, menuStack[level + 1]?.el.querySelector('.menu-item:not(.disabled)')); return; }
  closeMenus(0);
  it.run?.();
}

function showMenu(x, y, items, level, leftEdge) {
  const menu = el('div', 'context-menu');
  menu.dataset.level = level;
  let hoverTimer = null;
  for (const it of items.filter(Boolean)) {
    if (it.separator) { menu.appendChild(el('div', 'menu-sep')); continue; }
    if (it.header) { menu.appendChild(el('div', 'menu-header', it.header)); continue; }
    const row = el('div', 'menu-item' + (it.disabled ? ' disabled' : '') + (it.submenu ? ' has-sub' : ''));
    row._item = it;
    const icon = el('span', 'menu-icon');
    if (it.checked) icon.textContent = '✓';
    else if (it.icon) icon.appendChild(ide.icon(it.icon, it.glyph || ''));
    else if (it.glyph) icon.textContent = it.glyph;
    const label = el('span', 'menu-label', it.label);
    if (it.userText) label.dataset.userText = '';
    // The label stays the first child (callers read row.firstChild); CSS order draws the icon before it.
    row.append(label, icon);
    if (it.detail) { const d = el('span', 'menu-detail', it.detail); d.dataset.userText = ''; row.appendChild(d); }
    if (it.hint) row.appendChild(el('span', 'hint-right', it.hint));
    if (it.submenu) row.appendChild(el('span', 'menu-arrow', '›'));
    row.onmousedown = (e) => { e.preventDefault(); e.stopPropagation(); activate(level, row); };
    row.onmouseenter = () => {
      setActiveRow(level, it.disabled ? null : row);
      clearTimeout(hoverTimer);
      hoverTimer = setTimeout(() => {
        if (it.submenu && !it.disabled) openSubmenu(level, row);
        else closeMenus(level + 1);
      }, it.submenu ? 120 : 200);
    };
    menu.appendChild(row);
  }
  $('menuHost').appendChild(menu);
  menuStack[level] = { el: menu, active: null };
  const r = menu.getBoundingClientRect();
  let left = x;
  if (left + r.width > innerWidth - 4) left = leftEdge !== undefined ? leftEdge - r.width + 2 : innerWidth - r.width - 4;
  menu.style.left = `${Math.max(4, left)}px`;
  menu.style.top = `${Math.max(4, Math.min(y, innerHeight - r.height - 4))}px`;
  return menu;
}

ide.ui.contextMenu = (x, y, items) => {
  closeMenus(0);
  showMenu(x, y, items, 0);
  const dismiss = (e) => { if (!e.target.closest?.('.context-menu')) closeMenus(0); };
  const keys = (e) => {
    if (!menusOpen()) return;
    const level = menuStack.length - 1;
    const m = menuStack[level];
    if (!m) return;
    const rows = [...m.el.querySelectorAll('.menu-item:not(.disabled)')];
    const i = rows.indexOf(m.active);
    const handled = {
      ArrowDown: () => setActiveRow(level, rows[(i + 1) % rows.length]),
      ArrowUp: () => setActiveRow(level, rows[(i - 1 + rows.length) % rows.length]),
      ArrowRight: () => m.active?._item.submenu && activate(level, m.active),
      ArrowLeft: () => level > 0 && closeMenus(level),
      Enter: () => activate(level, m.active),
      Escape: () => (level > 0 ? closeMenus(level) : closeMenus(0)),
    }[e.key];
    if (!handled) return;
    e.preventDefault();
    e.stopPropagation();
    handled();
  };
  setTimeout(() => {
    if (!menuStack.length) return;
    addEventListener('mousedown', dismiss, true);
    addEventListener('keydown', keys, true);
    addEventListener('blur', ide.ui.closeMenus);
  });
  menuCleanup = () => {
    removeEventListener('mousedown', dismiss, true);
    removeEventListener('keydown', keys, true);
    removeEventListener('blur', ide.ui.closeMenus);
  };
  return menuStack[0].el;
};
ide.ui.menuOpen = menusOpen;

// buttons: [{label, primary?, run?(dialog) -> false keeps it open}]
ide.ui.dialog = ({ title, body, buttons = [{ label: tr('OK'), primary: true }], width = 520, onClose }) => {
  const backdrop = el('div', 'dialog-backdrop');
  const box = el('div', 'dialog');
  box.style.width = `${width}px`;
  const head = el('div', 'dialog-title', title);
  const content = el('div', 'dialog-body');
  // A string body is text: messages carry names (run configurations, files) that must never become markup.
  if (typeof body === 'string') content.textContent = body; else if (body) content.appendChild(body);
  const foot = el('div', 'dialog-buttons');
  const prevFocus = document.activeElement;
  const dlg = {
    el: box,
    body: content,
    close() {
      const hadFocus = box.contains(document.activeElement) || document.activeElement === document.body;
      backdrop.remove();
      removeEventListener('keydown', onKey, true);
      if (hadFocus) focusBack(prevFocus);
      onClose?.();
    },
  };
  for (const b of buttons) {
    const btn = el('button', b.primary ? 'primary' : 'secondary', b.label);
    btn.onclick = async () => { if ((await b.run?.(dlg)) !== false) dlg.close(); };
    foot.appendChild(btn);
  }
  const shown = (n) => !n.disabled && n.getClientRects().length > 0;
  // Only the topmost dialog takes keys, and none while a menu opened from it is up (the menu's Esc and Enter come first).
  // Tab and Shift+Tab cycle inside it (never into the editor behind); Enter on a focused button presses that button, in
  // a textarea it is a new line, and while an IME composes it commits the text.
  const onKey = (e) => {
    if (backdrop !== $('dialogHost').lastElementChild || menusOpen()) return;
    if (e.key === 'Escape') { e.stopPropagation(); dlg.close(); }
    if (e.key === 'Enter' && !e.isComposing && !['TEXTAREA', 'BUTTON', 'A'].includes(e.target.tagName)) {
      e.preventDefault(); // the keystroke must not also type into the field that gets the keyboard back
      e.stopPropagation();
      foot.querySelector('.primary')?.click();
    }
    if (e.key === 'Tab' && !e.ctrlKey && !e.altKey && !e.target.closest?.('.monaco-editor')) {
      const stops = [...box.querySelectorAll('button, input, select, textarea, a[href], [tabindex]')].filter((n) => n.tabIndex >= 0 && shown(n));
      const i = stops.indexOf(document.activeElement);
      if (i !== -1 && i !== (e.shiftKey ? 0 : stops.length - 1)) return;
      e.preventDefault();
      stops[e.shiftKey ? stops.length - 1 : 0]?.focus();
    }
  };
  addEventListener('keydown', onKey, true);
  box.append(head, content, foot);
  backdrop.appendChild(box);
  $('dialogHost').appendChild(backdrop);
  // The keyboard starts in the first field, or on the primary button of a dialog without fields.
  ([...content.querySelectorAll('input,select,textarea')].find(shown) || foot.querySelector('.primary') || foot.querySelector('button'))?.focus();
  return dlg;
};
// A message in the IDE's own dialog. window.alert() blocks the whole renderer until it is dismissed.
ide.ui.alert = (text) => {
  ide.ui.dialog({ title: '', body: el('div', 'dialog-message', text) });
};
// A yes/no question in the IDE's own dialog; resolves true for `ok`. window.confirm() would block the renderer.
ide.ui.confirm = (text, { title = '', ok = tr('OK') } = {}) => new Promise((resolve) => {
  let yes = false;
  ide.ui.dialog({
    title,
    body: el('div', 'dialog-message', text),
    onClose: () => resolve(yes),
    buttons: [{ label: ok, primary: true, run: () => { yes = true; } }, { label: tr('Cancel') }],
  });
});

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
  if (popupState || $('dialogHost').childElementCount || menusOpen()) return;
  if (e.key === 'Shift' && !e.ctrlKey && !e.altKey && !e.repeat) {
    // The key's own time, not the handling time: a busy renderer must not split one Double Shift into two Shifts.
    const now = e.timeStamp;
    if (now - lastShift < 350) { lastShift = 0; return fireCombo('Shift Shift', e); }
    lastShift = now;
    return;
  }
  if (!['Control', 'Alt', 'Shift', 'Meta'].includes(e.key)) lastShift = 0;
  fireCombo(comboOf(e), e);
}, true);

// Inside a terminal, keys belong to the program running there (Esc, Ctrl+T, Ctrl+K... matter to Claude Code, readline,
// vim); only actions marked 	erminal: true (tool windows and a few window-level ones) still fire, like PyCharm's
// "Override IDE shortcuts" terminal option.
const inTerminal = () => !!document.activeElement?.closest('[data-terminal]');

function fireCombo(combo, e) {
  const terminalFocused = inTerminal();
  for (let i = ide.actions.length - 1; i >= 0; i--) {
    const a = ide.actions[i];
    if (!a.keys.includes(combo) || (a.when && !a.when())) continue;
    if (terminalFocused && !a.terminal) continue;
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
// Items ordered 60-99 on the right form the run widget (configuration, Run, Debug, Stop), drawn as one pill.
ide.registerToolbarItem = ({ side = 'right', order = 100, el: node }) => placeOrdered(
  side === 'left' ? $('toolbarLeft') : order >= 60 && order < 100 ? $('runWidget') : $('toolbarRight'), node, order);
ide.registerStatusItem = ({ order = 100, el: node }) => placeOrdered($('statusItems'), node, order);
$('projectWidget').dataset.order = 0;

// ---------- tool windows ----------
const areas = {
  left: { panel: $('sidePanel'), splitter: $('sideSplitter'), body: $('sideBody'), actions: $('sideActions'), stripe: $('stripeTop'), title: $('sideTitle'), active: null },
  bottom: { panel: $('bottom'), splitter: $('bottomSplitter'), body: $('bottomBody'), actions: $('bottomActions'), stripe: $('stripeBottom'), active: null },
  right: { panel: $('rightPanel'), splitter: $('rightSplitter'), body: $('rightBody'), actions: $('rightActions'), stripe: $('stripeRightTop'), title: $('rightTitle'), active: null },
};

// PyCharm New UI icons (icons.js) for the built-in tool windows; plugins may pass iconName, or a text glyph as icon.
const TOOL_ICONS = { Project: 'project', Commit: 'commit', Structure: 'structure', Launchers: 'services', Run: 'run',
  Debug: 'debug', FindUsages: 'find', FindInFiles: 'find', PythonConsole: 'pythonConsole', Terminal: 'terminal',
  Problems: 'problems', Git: 'vcs', TODO: 'todo', PythonPackages: 'pythonPackages', AIChat: 'aiChat', CallHierarchy: 'hierarchy' };
ide.icon = (name, fallback = '') => {
  const svg = window.PYIDE_ICONS?.[name];
  const span = el('span', 'ide-icon');
  if (svg) span.innerHTML = svg; else span.textContent = fallback;
  return span;
};

// Like PyCharm's New UI, the sidebar shows only pinned tool windows (plus whichever is open right now); the rest live
// behind the "More" button. The pinned set is a user setting.
const DEFAULT_PINNED = ['Project', 'Commit', 'Structure', 'Run', 'Debug', 'Terminal', 'Problems'];
const pinnedIds = () => ide.settings.get('sidebar.pinned', DEFAULT_PINNED);
const isPinned = (id) => pinnedIds().includes(id);
function setPinned(id, pinned) {
  const list = pinnedIds().filter((x) => x !== id);
  if (pinned) list.push(id);
  ide.settings.set('sidebar.pinned', list);
  refreshStripe();
}
function refreshStripe() {
  for (const tw of ide.toolWindows.values()) {
    const shown = isPinned(tw.id) || tw.isVisible();
    tw.button.classList.toggle('hidden', !shown);
    tw.button.classList.toggle('unpinned', !isPinned(tw.id));
    tw.tab?.classList.toggle('hidden', !shown);
  }
}
ide.sidebar = { isPinned, setPinned, pinned: pinnedIds };

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
  refreshStripe();
}

// {id, title, icon, iconName?, side: 'left'|'bottom'|'right', keys?, order?, mount(container, tw)} -> tw {show, hide, toggle, setActions, setBadge, isVisible}
ide.registerToolWindow = ({ id, title, icon, iconName, side = 'bottom', keys, order = 100, mount }) => {
  const area = areas[side];
  const container = el('div', 'tool');
  area.body.appendChild(container);
  const button = el('button', 'stripe-btn');
  button.appendChild(ide.icon(iconName || TOOL_ICONS[id], icon));
  const keyText = keys ? normalizeKeys(keys).join(', ') : '';
  button.title = `${title}${keyText ? ` (${keyText})` : ''}`;
  button.dataset.tool = id;
  placeOrdered(area.stripe, button, order);
  let tab;
  if (side === 'bottom') {
    tab = el('button', 'bottom-tab');
    tab.appendChild(el('span', null, title));
    tab.appendChild(el('span', 'badge'));
    placeOrdered($('bottomTabs'), tab, order);
  }
  const tw = {
    id, title, area, container, button, actionList: [], keys: keyText, iconName: iconName || TOOL_ICONS[id], glyph: icon,
    isVisible: () => !area.panel.classList.contains('hidden') && area.active === tw,
    show() {
      area.active = tw;
      area.picked = true;
      for (const other of ide.toolWindows.values()) {
        if (other.area !== area) continue;
        other.container.classList.toggle('active', other === tw);
        other.tab?.classList.toggle('active', other === tw);
      }
      if (area.title) area.title.textContent = title;
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
  button.oncontextmenu = (e) => {
    e.preventDefault();
    ide.ui.contextMenu(e.clientX, e.clientY, [
      { label: tw.isVisible() ? tr('Hide') : tr('Show'), hint: keyText, run: tw.toggle },
      isPinned(id)
        ? { label: tr('Remove from Sidebar'), run: () => setPinned(id, false) }
        : { label: tr('Pin to Sidebar'), run: () => setPinned(id, true) },
    ]);
  };
  if (tab) tab.onclick = tw.show;
  ide.toolWindows.set(id, tw);
  // A window opened by its shortcut takes the keyboard, as in PyCharm: its field or list (show() already focuses a field),
  // else the window itself, so Esc (back to the editor) and Shift+Esc (hide) work from it. Other ways of showing it
  // leave the focus alone.
  const activate = () => {
    tw.toggle();
    if (!tw.isVisible() || container.contains(document.activeElement)) return;
    const target = [...container.querySelectorAll('[tabindex="0"], input:not([disabled]), textarea:not([disabled])')].find((n) => n.getClientRects().length);
    if (target) return target.focus();
    container.tabIndex = -1;
    container.focus();
  };
  if (keys) ide.registerAction({ id: `Activate${id}ToolWindow`, title: tr('Tool Window: {title}', { title }), keys, run: activate, terminal: true });
  mount?.(container, tw);
  // Until something is shown explicitly, the default window of an area is the one with the lowest order
  // (features load alphabetically, so registration order is not meaningful).
  tw.order = order;
  if (!area.active || (!area.picked && order < area.active.order)) {
    area.active?.container.classList.remove('active');
    area.active?.tab?.classList.remove('active');
    area.active = tw; container.classList.add('active'); tab?.classList.add('active'); if (area.title) area.title.textContent = title; renderAreaActions(area);
  }
  refreshStripe();
  return tw;
};
$('hideBottomBtn').onclick = () => areas.bottom.active?.hide();

// "More Tool Windows": every tool window, with a pin to keep it on the sidebar.
const moreBtn = $('stripeMore');
moreBtn.appendChild(ide.icon('more', '⋯'));
moreBtn.title = tr('More Tool Windows');
let morePanel = null;
function closeMore() {
  morePanel?.remove();
  morePanel = null;
  removeEventListener('mousedown', outsideMore, true);
  removeEventListener('keydown', escMore, true);
}
const outsideMore = (e) => { if (!morePanel?.contains(e.target) && !moreBtn.contains(e.target)) closeMore(); };
const escMore = (e) => { if (e.key === 'Escape') { e.stopPropagation(); closeMore(); } };
function renderMore() {
  morePanel.replaceChildren();
  for (const [side, label] of [['left', tr('Left')], ['bottom', tr('Bottom')], ['right', tr('Right')]]) {
    const list = [...ide.toolWindows.values()].filter((tw) => tw.area === areas[side]).sort((a, b) => a.order - b.order);
    if (!list.length) continue;
    morePanel.appendChild(el('div', 'more-group', label));
    for (const tw of list) {
      const row = el('div', 'more-row' + (tw.isVisible() ? ' visible' : ''));
      row.dataset.tool = tw.id;
      row.append(ide.icon(tw.iconName, tw.glyph), el('span', 'more-title', tw.title), el('span', 'more-keys', tw.keys));
      const pin = el('button', 'more-pin' + (isPinned(tw.id) ? ' pinned' : ''));
      pin.appendChild(ide.icon(isPinned(tw.id) ? 'pinSelected' : 'pin', '📌'));
      pin.title = isPinned(tw.id) ? tr('Remove from Sidebar') : tr('Pin to Sidebar');
      pin.onclick = (e) => { e.stopPropagation(); setPinned(tw.id, !isPinned(tw.id)); renderMore(); };
      row.appendChild(pin);
      row.onclick = () => { closeMore(); tw.show(); };
      morePanel.appendChild(row);
    }
  }
}
moreBtn.onclick = () => {
  if (morePanel) return closeMore();
  morePanel = el('div', 'more-panel');
  morePanel.id = 'moreToolWindows';
  document.body.appendChild(morePanel);
  renderMore();
  const r = moreBtn.getBoundingClientRect();
  morePanel.style.left = `${r.right + 6}px`;
  morePanel.style.top = `${Math.max(8, Math.min(r.bottom - morePanel.offsetHeight, innerHeight - morePanel.offsetHeight - 8))}px`;
  setTimeout(() => { addEventListener('mousedown', outsideMore, true); addEventListener('keydown', escMore, true); });
};
ide.on('settingsChanged', (key) => { if (key === 'sidebar.pinned') refreshStripe(); });

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

// ---------- project tree ----------
// The tree is a flat list of visible rows ({entry, depth}) built from listings of the open folders. Expanding or
// collapsing a folder splices only its rows, and only the rows in view (plus a margin) have DOM nodes, so a folder
// with 10,000 files costs one listing and about 60 nodes. Tree operations run one at a time in `treeQueue`.
const ROW_HEIGHT = 24;
const OVERSCAN = 10;
const EXPANDED_KEY = 'projectTree.expanded';
const keyOf = (p) => p.toLowerCase();
const expanded = new Set(); // keyOf(path) of every open folder
const treeDecorators = [];
const treeActions = [];
let rows = [];
let selected = null;

ide.registerTreeDecorator = (fn) => { treeDecorators.push(fn); };
// {title, when?(entry), run(entry)}; entry = {name, path, dir}
ide.registerTreeAction = (action) => { treeActions.push(action); };
ide.selectedTreeEntry = () => selected;

let treeQueue = Promise.resolve();
const enqueueTree = (fn) => (treeQueue = treeQueue.catch(() => {}).then(fn));
const listDir = (dir) => ide.api.list(dir).catch(() => []);
const rowIndexOf = (path) => rows.findIndex((r) => samePath(r.entry.path, path));

// The rows below an open folder: its open subfolders are listed level by level, each level in parallel.
async function subtreeRows(entry, depth) {
  const listings = new Map();
  for (let level = [entry.path]; level.length;) {
    const lists = await Promise.all(level.map(listDir));
    const next = [];
    level.forEach((dir, i) => {
      listings.set(keyOf(dir), lists[i]);
      for (const c of lists[i]) if (c.dir && expanded.has(keyOf(c.path))) next.push(c.path);
    });
    level = next;
  }
  const out = [];
  const add = (dir, d) => {
    for (const c of listings.get(keyOf(dir)) || []) {
      out.push({ entry: c, depth: d });
      if (c.dir && expanded.has(keyOf(c.path))) add(c.path, d + 1);
    }
  };
  add(entry.path, depth + 1);
  return out;
}

function rowNode({ entry, depth }, index) {
  const open = entry.dir && expanded.has(keyOf(entry.path));
  const node = el('div', 'node' + (selected && samePath(entry.path, selected.path) ? ' selected' : ''));
  node._entry = entry;
  node.style.top = `${index * ROW_HEIGHT}px`;
  node.style.paddingLeft = `${depth * 16 + 4}px`;
  node.draggable = depth > 0;
  node.appendChild(el('span', 'arrow', entry.dir ? (open ? '▾' : '▸') : ''));
  const icon = ide.fileIcon(entry.name, { dir: entry.dir });
  icon.classList.add('icon');
  node.appendChild(icon);
  const name = el('span', 'name', entry.name);
  node.appendChild(name);
  for (const deco of treeDecorators) {
    const d = deco(entry);
    if (d?.color) name.style.color = d.color;
    if (d?.badge) node.appendChild(el('span', 'tree-badge', d.badge));
  }
  return node;
}

// Draws the rows in view. A hidden tree (no height yet) still draws a screenful, so its first rows exist.
function drawTree() {
  const tree = $('tree');
  if (!tree) return;
  const canvas = tree.firstChild;
  canvas.style.height = `${rows.length * ROW_HEIGHT}px`;
  const view = tree.clientHeight || 40 * ROW_HEIGHT;
  const first = Math.max(0, Math.floor(tree.scrollTop / ROW_HEIGHT) - OVERSCAN);
  const last = Math.min(rows.length, Math.ceil((tree.scrollTop + view) / ROW_HEIGHT) + OVERSCAN);
  const nodes = [];
  for (let i = first; i < last; i++) nodes.push(rowNode(rows[i], i));
  canvas.replaceChildren(...nodes);
}

function scrollToRow(i) {
  const tree = $('tree');
  if (i * ROW_HEIGHT < tree.scrollTop) tree.scrollTop = i * ROW_HEIGHT;
  else if ((i + 1) * ROW_HEIGHT > tree.scrollTop + tree.clientHeight) tree.scrollTop = (i + 1) * ROW_HEIGHT - tree.clientHeight;
}

function selectRow(i) {
  if (!rows.length) return;
  i = Math.max(0, Math.min(rows.length - 1, i));
  selected = rows[i].entry;
  scrollToRow(i);
  drawTree();
}

// Open folders are remembered per project (relative, lower-cased paths) and listed again when it opens.
let saveExpandedTimer = null;
function saveExpanded() {
  clearTimeout(saveExpandedTimer);
  const root = ide.root;
  saveExpandedTimer = setTimeout(() => {
    if (!root || !samePath(root, ide.root)) return;
    const open = rows.filter((r) => r.depth > 0 && r.entry.dir && expanded.has(keyOf(r.entry.path))).map((r) => keyOf(r.entry.path).slice(root.replace(/[\\/]+$/, '').length + 1));
    const keep = new Set(ide.settings.get('recentProjects', []).map((p) => keyOf(p.path)));
    const all = Object.fromEntries(Object.entries(ide.settings.get(EXPANDED_KEY, {})).filter(([k]) => keep.has(k)));
    ide.settings.set(EXPANDED_KEY, { ...all, [keyOf(root)]: open.slice(0, 500) });
  }, 1000);
}

// Lists every open folder again (files may have changed on disk) and redraws. Calls made while one is waiting to
// start share it; a call made while one runs gets its own run afterwards.
let pendingRefresh = null;
function renderTree() {
  pendingRefresh ||= enqueueTree(async () => {
    pendingRefresh = null;
    const rootPath = ide.root;
    if (!rootPath || !$('tree')) return;
    const root = { name: basename(rootPath), path: rootPath, dir: true };
    const below = expanded.has(keyOf(rootPath)) ? await subtreeRows(root, 0) : [];
    if (!samePath(rootPath, ide.root)) return;
    rows = [{ entry: root, depth: 0 }, ...below];
    drawTree();
    if (!performance.getEntriesByName('pyide:tree').length) performance.mark('pyide:tree');
    ide.emit('treeRefreshed');
  });
  return pendingRefresh;
}
ide.refreshTree = renderTree;

const toggleDir = (entry) => enqueueTree(async () => {
  const i = rowIndexOf(entry.path);
  if (i < 0) return;
  const { depth } = rows[i];
  const k = keyOf(entry.path);
  if (expanded.has(k)) {
    expanded.delete(k);
    let end = i + 1;
    while (end < rows.length && rows[end].depth > depth) end++;
    rows.splice(i + 1, end - i - 1);
  } else {
    const rootPath = ide.root;
    expanded.add(k);
    const below = await subtreeRows(rows[i].entry, depth);
    if (!samePath(rootPath, ide.root)) return;
    rows = rows.slice(0, i + 1).concat(below, rows.slice(i + 1));
  }
  saveExpanded();
  drawTree();
});

ide.revealInTree = async (path) => {
  let d = dirname(path);
  while (d && d.length >= (ide.root || '').length) { expanded.add(keyOf(d)); d = dirname(d); }
  selected = { name: basename(path), path, dir: false };
  await renderTree();
  const i = rowIndexOf(path);
  if (i >= 0) selectRow(i);
  saveExpanded();
};

const selectedDir = () => (!selected ? ide.root : selected.dir ? selected.path : dirname(selected.path));
// The message of an error a main-process handler threw, without Electron's "Error invoking remote method" prefix.
// The file-system errors users meet read as a sentence instead of Node's "EBUSY: resource busy or locked, open '…'".
const FS_ERRORS = {
  EBUSY: tr('The file is in use by another program'),
  EPERM: tr('Access is denied (the file may be read-only)'),
  EACCES: tr('Access is denied (the file may be read-only)'),
  ENOENT: tr('The file or folder does not exist'),
  EISDIR: tr('It is a folder, not a file'),
  ENOTDIR: tr('A part of the path is a file, not a folder'),
  ENOSPC: tr('The disk is full'),
  EROFS: tr('The disk is read-only'),
  ENAMETOOLONG: tr('The path is too long'),
};
const ipcError = (e) => {
  const text = String(e?.message || e).replace(/^Error invoking remote method '[^']+': (Error: )?/, '');
  const code = /^([A-Z]+): /.exec(text)?.[1];
  return FS_ERRORS[code] || text;
};
ide.util.errorText = ipcError;

async function createEntry(isDir) {
  if (!ide.root) return;
  const name = await ide.ui.prompt(isDir ? tr('New directory name') : tr('New Python file name'), isDir ? '' : 'main.py');
  if (!name) return;
  const target = joinPath(selectedDir(), !isDir && !name.includes('.') ? `${name}.py` : name);
  if (await ide.api.exists(target)) return void ide.ui.alert(tr('{path} already exists', { path: basename(target) }));
  try {
    await ide.api.create(target, isDir);
    expanded.add(keyOf(dirname(target)));
    await renderTree();
    ide.emit('filesChanged', { created: [target] });
    if (!isDir) ide.openFile(target);
  } catch (e) { ide.ui.alert(ipcError(e)); }
}

// Renames or moves a file or folder. Windows' rename replaces an existing file, so an existing target is refused.
// Open files under it are saved first and reopened from their new place.
async function moveTo(entry, to) {
  if (!samePath(entry.path, to) && await ide.api.exists(to)) return void ide.ui.alert(tr('{path} already exists', { path: to }));
  const open = ide.tabs.filter((t) => t.kind === 'file' && isUnder(t.path, entry.path));
  for (const t of open) if (ide.isDirty(t)) await ide.saveTab(t);
  try { await ide.api.rename(entry.path, to); } catch (e) { return void ide.ui.alert(ipcError(e)); }
  for (const t of open) ide.closeTab(t.path, true);
  renderTree();
  ide.emit('filesChanged', { renamed: [[entry.path, to]] });
  for (const p of new Set(open.map((t) => t.path))) ide.openFile(to + p.slice(entry.path.length));
}

async function renameEntry(entry) {
  const name = await ide.ui.prompt(tr('New name'), entry.name);
  if (!name || name === entry.name) return;
  await moveTo(entry, joinPath(dirname(entry.path), name));
}

// Dropping a row on a folder moves it there, after a confirmation.
async function moveEntry(entry, dir) {
  if (samePath(dirname(entry.path), dir) || isUnder(dir, entry.path)) return;
  if (!(await ide.ui.confirm(tr('Move {name} to {dir}?', { name: entry.name, dir: ide.util.rel(dir) || basename(dir) }), { ok: tr('Move') }))) return;
  expanded.add(keyOf(dir));
  await moveTo(entry, joinPath(dir, entry.name));
}

async function deleteEntry(entry) {
  if (!(await ide.ui.confirm(tr('Move {name} to the Recycle Bin?', { name: entry.name }), { ok: tr('Delete') }))) return;
  // A file another program holds open, or a drive without a Recycle Bin, stays where it is.
  try { await ide.api.trash(entry.path); } catch (e) {
    return void ide.ui.alert(tr('Could not move {name} to the Recycle Bin: {error}', { name: entry.name, error: ipcError(e) }));
  }
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

// Up/Down/Home/End/PageUp/PageDown move the selection, Right opens a folder or enters it, Left closes it or goes to
// the parent, Enter opens a file or toggles a folder, Delete moves the selection to the Recycle Bin.
function treeKey(e) {
  if (e.ctrlKey || e.altKey || e.metaKey || !rows.length) return;
  const i = selected ? rowIndexOf(selected.path) : -1;
  const row = rows[i];
  const page = Math.max(1, Math.floor($('tree').clientHeight / ROW_HEIGHT) - 1);
  const isOpen = row?.entry.dir && expanded.has(keyOf(row.entry.path));
  const keys = {
    ArrowDown: () => selectRow(i + 1),
    ArrowUp: () => selectRow(i < 0 ? 0 : i - 1),
    Home: () => selectRow(0),
    End: () => selectRow(rows.length - 1),
    PageDown: () => selectRow(i + page),
    PageUp: () => selectRow(i - page),
    ArrowRight: () => row?.entry.dir && (isOpen ? rows[i + 1]?.depth > row.depth && selectRow(i + 1) : toggleDir(row.entry)),
    ArrowLeft: () => {
      if (!row) return;
      if (isOpen) return toggleDir(row.entry);
      let j = i - 1;
      while (j >= 0 && rows[j].depth >= row.depth) j--;
      if (j >= 0) selectRow(j);
    },
    Enter: () => row && (row.entry.dir ? toggleDir(row.entry) : ide.openFile(row.entry.path)),
    Delete: () => row && row.depth > 0 && deleteEntry(row.entry),
  };
  if (!keys[e.key]) return;
  e.preventDefault();
  e.stopPropagation();
  keys[e.key]();
}

function wireTree(tree) {
  const entryAt = (e) => e.target.closest?.('.node')?._entry;
  tree.addEventListener('scroll', drawTree, { passive: true });
  observeSize(tree, () => drawTree());
  tree.addEventListener('keydown', treeKey);
  tree.addEventListener('click', (e) => {
    const entry = entryAt(e);
    if (!entry) return;
    selected = entry;
    drawTree();
    // Shift+click opens a file beside the current pane; a single click opens it as a preview tab.
    if (entry.dir) toggleDir(entry);
    else ide.openFile(entry.path, e.shiftKey ? { group: 'right' } : { preview: true });
  });
  // Double-click keeps a file that a single click opened as a preview tab.
  tree.addEventListener('dblclick', (e) => {
    const entry = entryAt(e);
    if (entry && !entry.dir) ide.openFile(entry.path);
  });
  tree.addEventListener('contextmenu', (e) => {
    const entry = entryAt(e);
    if (!entry) return;
    e.preventDefault();
    selected = entry;
    drawTree();
    showTreeMenu(entry, e.clientX, e.clientY);
  });
  // Drag a row onto a folder to move it, or onto an editor to open it there (editors.js reads the path type).
  let dragged = null;
  const dropDir = (e) => {
    const entry = entryAt(e);
    return entry && dragged && (entry.dir ? entry.path : dirname(entry.path));
  };
  const clearDropMark = () => tree.querySelectorAll('.drop-into').forEach((n) => n.classList.remove('drop-into'));
  tree.addEventListener('dragstart', (e) => {
    dragged = entryAt(e);
    if (!dragged) return;
    // No text/plain: Monaco would type the path into the editor it is dropped on.
    e.dataTransfer.setData(ide.TREE_PATH_TYPE, dragged.path);
    e.dataTransfer.effectAllowed = 'copyMove';
  });
  // On the document: the row the drag started from may have been redrawn (auto-scroll, a refresh) and detached.
  document.addEventListener('dragend', () => { dragged = null; clearDropMark(); });
  tree.addEventListener('dragover', (e) => {
    const dir = dropDir(e);
    clearDropMark();
    if (!dir || samePath(dirname(dragged.path), dir) || isUnder(dir, dragged.path)) return;
    e.preventDefault();
    e.dataTransfer.dropEffect = 'move';
    const i = rowIndexOf(dir);
    [...tree.firstChild.children].find((n) => n._entry === rows[i]?.entry)?.classList.add('drop-into');
  });
  tree.addEventListener('drop', (e) => {
    const dir = dropDir(e);
    const entry = dragged;
    clearDropMark();
    if (!dir) return;
    e.preventDefault();
    e.stopPropagation();
    moveEntry(entry, dir);
  });
}
ide.TREE_PATH_TYPE = 'application/x-pyide-path';

ide.registerToolWindow({
  id: 'Project', title: tr('Project'), icon: '▤', side: 'left', keys: 'Alt+1', order: 0,
  mount(container, tw) {
    const tree = el('div');
    tree.id = 'tree';
    tree.tabIndex = 0;
    tree.appendChild(el('div', 'tree-canvas'));
    container.appendChild(tree);
    wireTree(tree);
    tw.setActions([
      { icon: '＋', title: tr('New Python File'), run: () => createEntry(false) },
      { icon: '▣', title: tr('New Directory'), run: () => createEntry(true) },
      { icon: '⟳', title: tr('Refresh'), run: renderTree },
    ]);
  },
});

// ---------- interpreters ----------
// interpreterProviders: async (root) => interps, for interpreters that are not local executables.
// pathMappers: (path) => local path or null, so a path a remote interpreter printed (a traceback) opens here.
ide.interpreterProviders = [];
ide.pathMappers = [];
ide.toLocalPath = (p) => {
  for (const map of ide.pathMappers) {
    const local = map(p);
    if (local) return local;
  }
  return p;
};
ide.currentInterp = () => ide.interps[$('interpSelect').selectedIndex] || null;
// Only the latest call applies its list: probing a project's venvs can take seconds, and a call for the project
// that was open before must not replace the list of the one opened since. An overtaken call resolves with the latest.
let interpSeq = 0;
let interpLoad = null;
ide.reloadInterpreters = () => (interpLoad = loadInterpreters(++interpSeq));
async function loadInterpreters(seq) {
  const root = ide.root;
  const interps = await ide.api.interpreters(root, ide.settings.get('interpreters.extra', []));
  // Plugins add interpreters that are not local executables (remote-interp: WSL, SSH, Docker targets).
  for (const provide of ide.interpreterProviders) {
    try { interps.push(...await provide(root)); } catch (err) { console.warn('interpreter provider failed', err); }
  }
  if (seq !== interpSeq) return interpLoad;
  ide.interps = interps;
  const sel = $('interpSelect');
  sel.innerHTML = '';
  for (const it of ide.interps) sel.add(new Option(it.label));
  if (!ide.interps.length) sel.add(new Option(tr('<No interpreter>')));
  const preferred = ide.settings.get(`interpreter.${ide.root}`, '');
  const idx = ide.interps.findIndex((i) => samePath(i.executable, preferred));
  if (idx >= 0) sel.selectedIndex = idx;
  $('statusInterpLabel').textContent = ide.currentInterp()?.label || tr('No interpreter');
  ide.emit('interpreterChanged', ide.currentInterp());
}
// Selects an interpreter by its python.exe (the status-bar widget and the New Project wizard use this).
ide.setInterpreter = (executable) => {
  const i = ide.interps.findIndex((x) => samePath(x.executable, executable));
  if (i < 0) return false;
  $('interpSelect').selectedIndex = i;
  $('interpSelect').onchange();
  return true;
};
$('interpSelect').onchange = () => {
  const it = ide.currentInterp();
  $('statusInterpLabel').textContent = it?.label || '';
  if (it && ide.root) ide.settings.set(`interpreter.${ide.root}`, it.executable);
  ide.emit('interpreterChanged', it);
};

// ---------- project ----------
// A folder the user has not trusted (main/trust.js) asks first, like PyCharm's "Trust and Open Project": trusted, it
// opens normally; in Safe Mode it opens without running anything it ships (its venv's Python, git, its .env).
// Resolves 'trusted', 'safe' or null (cancelled).
async function askTrust(dir) {
  if (await ide.api.invoke('trust:isTrusted', dir)) return 'trusted';
  return new Promise((resolve) => {
    let answer = null;
    ide.ui.dialog({
      title: tr('Trust and Open Project?'),
      body: el('div', 'dialog-message', tr('{name} can run code when PyIDE works with it: its virtual environment\'s Python, its Git configuration and its .env file. Trust it only if you know where it comes from. Safe Mode opens it without running anything from it.', { name: basename(dir) })),
      width: 560,
      onClose: () => resolve(answer),
      buttons: [
        { label: tr('Trust Project'), primary: true, run: async () => { await ide.api.invoke('trust:add', dir); answer = 'trusted'; } },
        { label: tr('Preview in Safe Mode'), run: () => { answer = 'safe'; } },
        { label: tr('Cancel') },
      ],
    });
  });
}

const trustBar = el('div', 'trust-bar hidden');
trustBar.id = 'trustBar';
$('center').prepend(trustBar);
function showTrustBar(dir) {
  trustBar.replaceChildren(el('span', null, tr('Safe Mode: PyIDE runs nothing from this project (its venv, Git, .env).')));
  const btn = el('button', 'primary', tr('Trust Project'));
  btn.onclick = async () => {
    await ide.api.invoke('trust:add', dir);
    // Every feature starts over as for a trusted project: interpreters, Git, Pyright with the project venv. The page
    // reopens this project (the window's own ?open= is the folder it was started with).
    if (!(await ide.closeAllTabs(false))) return;
    const url = new URL(location.href);
    url.searchParams.set('open', dir);
    url.searchParams.delete('file');
    location.replace(url.href);
  };
  trustBar.appendChild(btn);
  trustBar.classList.remove('hidden');
}

// Returns false if the user kept unsaved files of the current project open (each one asks, as Close Project does),
// or did not open an untrusted folder.
ide.openProject = async (dir) => {
  const trust = await askTrust(dir);
  if (!trust) return false;
  if (!(await ide.closeAllTabs(false))) return false;
  ide.trusted = trust === 'trusted';
  if (ide.trusted) trustBar.classList.add('hidden'); else showTrustBar(dir);
  ide.root = dir;
  expanded.clear();
  expanded.add(keyOf(dir));
  for (const rel of ide.settings.get(EXPANDED_KEY, {})[keyOf(dir)] || []) expanded.add(keyOf(joinPath(dir, rel)));
  selected = null;
  rows = [];
  drawTree();
  $('tree').scrollTop = 0;
  document.title = `${basename(dir)} - PyIDE`;
  $('welcome').classList.add('hidden');
  await Promise.all([renderTree(), ide.reloadInterpreters()]);
  try { localStorage.setItem('lastProject', dir); } catch {}
  const recent = ide.settings.get('recentProjects', []).filter((p) => !samePath(p.path, dir));
  ide.settings.set('recentProjects', [{ path: dir, opened: Date.now() }, ...recent].slice(0, 15));
  ide.emit('projectOpened', dir);
  return true;
};

// Whether a recent project's folder can be opened: 'exists', 'missing' (deleted; its drive or share is there), or
// null when it cannot be reached (a network share that does not answer, a drive that is not connected; the user is
// told, and it stays in the lists since it may come back) or the user cancelled. Such a share takes ~20 s to fail,
// so after a moment a dialog says it is connecting and offers Cancel, and after PROBE_MS it is reported unreachable.
const PROBE_MS = 5000;
let probing = false;
ide.probeProject = async (dir) => {
  if (probing) return null;
  probing = true;
  let dlg = null;
  let done = false;
  let cancelled = false;
  const later = setTimeout(() => {
    dlg = ide.ui.dialog({ title: tr('Opening Project'), body: tr('Connecting to {path}…', { path: dir }), width: 460,
      buttons: [{ label: tr('Cancel') }], onClose: () => { if (!done) cancelled = true; } });
  }, 300);
  let state;
  try { state = await ide.api.invoke('fs:probe', dir, PROBE_MS); } catch { state = 'unreachable'; }
  done = true;
  probing = false;
  clearTimeout(later);
  if (cancelled) return null;
  dlg?.close();
  if (state !== 'unreachable') return state;
  ide.ui.alert(tr('{path} cannot be reached. Check the network connection or that the drive is connected, then try again.', { path: dir }));
  return null;
};

// Back to the welcome screen, like PyCharm's File > Close Project. Returns false if the user kept unsaved files open.
ide.closeProject = async () => {
  if (!ide.root || !(await ide.closeAllTabs(false))) return false;
  ide.root = null;
  trustBar.classList.add('hidden');
  expanded.clear();
  selected = null;
  rows = [];
  drawTree();
  document.title = 'PyIDE';
  $('welcome').classList.remove('hidden');
  try { localStorage.removeItem('lastProject'); } catch {}
  await ide.reloadInterpreters();
  ide.emit('projectClosed');
  return true;
};

ide.pickAndOpenProject = pickFolder;
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
      const delta = ((vertical ? e.clientX : e.clientY) - start) * (s.dataset.grow === 'left' ? -1 : 1);
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
  let files;
  try { files = await ide.api.walk(ide.root); } catch (e) {
    return void ide.ui.alert(tr('Cannot open {name}: {error}', { name: basename(ide.root), error: ipcError(e) }));
  }
  const path = await ide.ui.pick({
    placeholder: tr('Search files'),
    items: files.map((p) => ({ label: basename(p), detail: ide.util.rel(dirname(p)), icon: ide.fileIcon(p), value: p })),
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
  { id: 'SaveAll', title: tr('Save All'), keys: 'Ctrl+S', run: () => ide.saveAll() },
  { id: 'OpenProject', title: tr('Open Folder…'), keys: 'Ctrl+O', run: pickFolder },
  { id: 'GotoFile', title: tr('Go to File…'), keys: 'Ctrl+Shift+N', run: gotoFile },
  { id: 'GotoAction', title: tr('Find Action…'), keys: 'Ctrl+Shift+A', run: findAction, terminal: true },
  { id: 'NewPythonFile', title: tr('New Python File'), keys: 'Alt+Insert', run: () => createEntry(false) },
  // The window that has the keyboard (left, right or bottom), else the bottom one.
  { id: 'HideBottom', title: tr('Hide Active Tool Window'), keys: 'Shift+Escape', terminal: true,
    run: () => (Object.values(areas).find((a) => a.panel.contains(document.activeElement)) || areas.bottom).active?.hide() },
  { id: 'FocusEditor', keys: 'Escape', when: () => !inEditor() && !document.activeElement?.closest('.editor-group') && !!ide.editor?.getModel(), run: () => ide.editor.focus() },
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

$('welcomeOpen').onclick = pickFolder;

// ---------- boot ----------
ide.api = window.api;
// Monaco cancels in-flight provider requests (e.g. word highlight) when the model switches and leaves the
// rejection unhandled; Monaco itself treats these as non-errors.
addEventListener('unhandledrejection', (e) => { if (e.reason?.name === 'Canceled' && e.reason?.message === 'Canceled') e.preventDefault(); });

// Plugin scripts are fetched in parallel; async = false still runs them in list order (dependencies first).
async function loadFeatures() {
  const plugins = await ide.api.invoke('core:features');
  await Promise.all(plugins.map((p) => {
    if (p.css) {
      const link = el('link');
      link.rel = 'stylesheet';
      link.href = p.css;
      document.head.appendChild(link);
    }
    return new Promise((resolve) => {
      const s = el('script');
      s.src = p.script;
      s.async = false;
      s.onload = resolve;
      s.onerror = () => { console.error(`plugin ${p.id} failed to load`); resolve(); };
      document.body.appendChild(s);
    });
  }));
}

// The relaunch exits without unloading the window, so pending settings are written first.
ide.restart = () => { flushSettings(); return ide.api.relaunch(); };

require.config({ paths: { vs: '../node_modules/monaco-editor/min/vs' } });
// Monaco's default blob worker cannot importScripts() a file:// URL (uncaught ErrorEvent); load the worker script directly.
window.MonacoEnvironment = { getWorkerUrl: () => new URL('../node_modules/monaco-editor/min/vs/base/worker/workerMain.js', location.href).href };
// Monaco's own UI strings (find widget, context menu, command palette) come from its NLS bundle for the locale.
const monacoNls = i18n.locale === 'en' ? [] : [`vs/nls.messages.${i18n.locale}`];
require(monacoNls, () => require(['vs/editor/editor.main'], async () => {
  const monaco = (ide.monaco = window.monaco);
  // Diff editors leave their hunk gutter menu subscribed after dispose, and it throws "AbstractContextKeyService has
  // been disposed" whenever an editor action is registered later. PyIDE puts nothing in that menu.
  const createDiffEditor = monaco.editor.createDiffEditor;
  monaco.editor.createDiffEditor = (el, options, override) => createDiffEditor(el, { renderGutterMenu: false, ...options }, override);
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

  ide.initEditors({
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

  performance.mark('pyide:monaco');
  await loadFeatures();
  performance.mark('pyide:features');
  ide.emit('ready');
  if (ide.detached) {
    await ide.initDetachedWindow();
    window.__ideReady = true;
    return;
  }

  const params = new URLSearchParams(location.search);
  const last = params.get('open') || (() => { try { return localStorage.getItem('lastProject'); } catch { return null; } })();
  // A last project on a network share that does not answer (~20 s to fail) leaves the welcome screen up after 3 s;
  // Recent Projects opens it once the share is back.
  const reachable = (p) => Promise.race([ide.api.exists(p), new Promise((r) => { setTimeout(r, 3000, false); })]);
  if (last && await reachable(last)) await ide.openProject(last);
  else await ide.reloadInterpreters();
  if (params.get('file') && ide.root) await ide.openFile(params.get('file'));
  performance.mark('pyide:ready');
  window.__ideReady = true;
}));
