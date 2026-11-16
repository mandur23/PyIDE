// Tool windows in windows of their own: "Open Panel in New Window" on a tool window's stripe button, bottom tab or side
// panel header (Window › Open Tool Window in New Window…, Find Action in Craft). The new window is an empty page this
// page opens (main/security.js allows exactly that) and draws the panel into: the panel's element moves there, so its
// state (a terminal's process, a server console, a half-typed field) stays the same objects in this one page, with no
// copy to keep in step. Closing the window puts the panel back in its place; closing the main window closes them all.
// Which tool windows are out and where their windows were is the setting `popout.windows` ({[mode]: {[id]: {open,
// bounds}}}), restored at start (main/windows.js puts a window whose screen is gone back on the main window's).
//
// The page spans several documents while a panel is out, so this file makes that hold for the code that assumes one:
// document.activeElement answers for the window the user works in, document.getElementById, querySelector(All) and
// contains also look in the panel windows, the keymap listens in them (ide.keymap.listenIn), menus, dialogs and the
// popup chooser open in the window the user works in (ide.js uiWin), and ResizeObservers follow the elements that moved
// (ide.util.rehomeObservers). Plugins that keep an xterm move it with `panelMoved`.
(() => {
  if (ide.detached || ide.appMode === 'cut') return;
  const { el } = ide.util;
  const KEY = 'popout.windows';
  const open = new Map(); // tool window id -> {tw, win, mirror}
  let lastWin = window; // the window the user worked in last
  let leaving = false; // this page is unloading: its panel windows close but stay remembered as open

  // ---------- remembered state ----------
  const all = () => { const v = ide.settings.get(KEY, {}); return v && typeof v === 'object' && !Array.isArray(v) ? v : {}; };
  const saved = () => { const m = all()[ide.appMode]; return m && typeof m === 'object' && !Array.isArray(m) ? m : {}; };
  const validBounds = (b) => !!b && ['x', 'y', 'width', 'height'].every((k) => Number.isFinite(b[k])) && b.width >= 200 && b.height >= 120;
  function remember(id, patch) {
    const mine = saved();
    ide.settings.set(KEY, { ...all(), [ide.appMode]: { ...mine, [id]: { ...(mine[id] && typeof mine[id] === 'object' ? mine[id] : {}), ...patch } } });
  }
  // The bounds come from main/windows.js (its own units, the frame's invisible borders included), as they change.
  ide.api.on('window:popoutBounds', ({ name, bounds } = {}) => {
    if (typeof name === 'string' && validBounds(bounds) && (open.has(name) || saved()[name])) remember(name, { bounds });
  });

  // ---------- one document for the code that reads `document` ----------
  const D = Document.prototype;
  const nativeActive = Object.getOwnPropertyDescriptor(D, 'activeElement').get;
  const docs = () => [...open.values()].map((p) => p.win.document);
  const usable = (win) => win !== window && !win.closed && [...open.values()].some((p) => p.win === win);
  Object.defineProperty(document, 'activeElement', {
    configurable: true,
    get: () => (usable(lastWin) ? nativeActive.call(lastWin.document) : nativeActive.call(document)),
  });
  document.getElementById = (id) => {
    const n = D.getElementById.call(document, id);
    if (n || !open.size) return n;
    for (const d of docs()) { const m = d.getElementById(id); if (m) return m; }
    return null;
  };
  document.querySelector = (sel) => {
    const n = D.querySelector.call(document, sel);
    if (n || !open.size) return n;
    for (const d of docs()) { const m = d.querySelector(sel); if (m) return m; }
    return null;
  };
  document.querySelectorAll = (sel) => {
    const list = D.querySelectorAll.call(document, sel);
    if (!open.size) return list;
    return [...list, ...docs().flatMap((d) => [...d.querySelectorAll(sel)])];
  };
  document.contains = (n) => Node.prototype.contains.call(document, n) || docs().some((d) => d.contains(n));

  const track = (win) => {
    const mark = () => { lastWin = win; };
    win.addEventListener('focus', mark);
    for (const type of ['pointerdown', 'mousedown', 'contextmenu', 'keydown', 'focusin']) win.addEventListener(type, mark, true);
  };
  track(window);

  // ---------- the window's page ----------
  // Stylesheets (the core's, the plugins', Monaco's rules) are copied in and kept in step; the theme, language and body
  // classes (app mode, power save) follow the main page's.
  function mirror(doc) {
    const clones = new Map();
    const copy = (n) => {
      if (!n.matches?.('link[rel~="stylesheet"], style')) return;
      const c = doc.importNode(n, true);
      if (n.tagName === 'LINK') c.setAttribute('href', n.href);
      else if (n.sheet) {
        try {
          const text = [...n.sheet.cssRules].map((r) => r.cssText).join('\n');
          if (text.trim() && text !== n.textContent) c.textContent = text;
        } catch {}
      }
      clones.get(n)?.remove();
      clones.set(n, c);
      const next = [...clones.keys()].find((o) => o !== n && n.compareDocumentPosition(o) & Node.DOCUMENT_POSITION_FOLLOWING);
      doc.head.insertBefore(c, (next && clones.get(next)) || null);
    };
    for (const n of document.head.children) copy(n);
    const attrs = (from, to, extra = '') => {
      for (const a of [...to.attributes]) if (!from.hasAttribute(a.name) && a.name !== 'class') to.removeAttribute(a.name);
      for (const a of from.attributes) if (a.name !== 'class' && a.name !== 'id') to.setAttribute(a.name, a.value);
      to.className = `${from.className} ${extra}`.trim();
    };
    const sync = () => {
      attrs(document.documentElement, doc.documentElement);
      attrs(document.body, doc.body, 'popout-page');
    };
    sync();
    const heads = new MutationObserver((records) => {
      for (const r of records) {
        if (r.type === 'childList' && r.target === document.head) {
          for (const n of r.removedNodes) { clones.get(n)?.remove(); clones.delete(n); }
          for (const n of r.addedNodes) copy(n);
        } else {
          const style = r.target.nodeType === Node.TEXT_NODE ? r.target.parentNode : r.target.closest?.('style');
          if (style?.parentNode === document.head) copy(style);
        }
      }
    });
    heads.observe(document.head, { childList: true, subtree: true, characterData: true });
    const roots = new MutationObserver(sync);
    roots.observe(document.documentElement, { attributes: true });
    roots.observe(document.body, { attributes: true });
    // Rules inserted with insertRule change no node: a theme change rewrites Monaco's.
    const offTheme = ide.on('themeChanged', () => { for (const n of [...clones.keys()]) if (n.tagName === 'STYLE') copy(n); });
    return () => { heads.disconnect(); roots.disconnect(); offTheme(); };
  }

  const sideOf = (tw) => (tw.area.panel.id === 'bottom' ? 'bottom' : 'side');
  // Craft hides the left side (Code's Project and the like); its consoles are at the bottom, Notifications on the right.
  const offered = (tw) => ide.appMode !== 'craft' || tw.area.panel.id !== 'sidePanel';
  // A first window opens beside the main window's top left corner (main/windows.js), at the shape of its area.
  const firstFeatures = (tw) => (sideOf(tw) === 'bottom' ? 'width=900,height=360' : 'width=380,height=640');

  function renderActions(p) {
    p.actions.replaceChildren();
    for (const a of p.tw.actionList || []) {
      const b = el('button');
      b.appendChild(ide.icon(a.icon));
      if (a.keyAction) ide.keymap.tooltip(b, a.title, a.keyAction);
      else b.title = a.title;
      b.onclick = a.run;
      if (a.id) b.dataset.action = a.id;
      if (typeof a.toggled === 'boolean') { b.classList.toggle('toggled', a.toggled); b.setAttribute('aria-pressed', String(a.toggled)); }
      p.actions.appendChild(b);
    }
  }

  const titleOf = (tw) => `${tw.title} - ${ide.appTitle}`;

  // The panel moves in once the window's stylesheets have loaded: laid out without them, a terminal fits itself to a
  // few columns and its shell rewraps what it shows.
  const stylesLoaded = (doc) => Promise.race([
    Promise.all([...doc.querySelectorAll('link[rel~="stylesheet"]')].map((l) => l.sheet || new Promise((r) => { l.addEventListener('load', r); l.addEventListener('error', r); }))),
    new Promise((r) => { setTimeout(r, 3000); }),
  ]);

  // -> whether the tool window is now in a window of its own.
  const opening = new Set();
  async function popOut(tw, { focus = true } = {}) {
    if (tw.popout) { if (focus) tw.popout.focus(); return true; }
    if (!ide.root || opening.has(tw.id) || !offered(tw)) return false;
    const b = saved()[tw.id]?.bounds;
    const win = window.open('about:blank', `pyide-popout:${tw.id}`, validBounds(b) ? `left=${b.x},top=${b.y},width=${b.width},height=${b.height}` : firstFeatures(tw));
    if (!win) return false;
    const doc = win.document;
    doc.title = titleOf(tw);
    const p = { tw, win };
    p.unmirror = mirror(doc);
    opening.add(tw.id);
    try { await stylesLoaded(doc); } finally { opening.delete(tw.id); }
    if (win.closed || tw.popout || !ide.root) { p.unmirror(); if (!win.closed) win.close(); return false; }
    const root = el('div', `popout-root popout-${sideOf(tw)}`);
    const head = el('div', 'panel-header popout-head');
    p.actions = el('span', 'panel-actions popout-actions');
    const dock = el('button', 'popout-dock');
    dock.appendChild(ide.icon('back', '↩'));
    dock.title = tr('Return to Main Window');
    dock.onclick = () => dockBack(tw);
    head.append(el('span', 'popout-title', tw.title), el('span', 'spacer'), p.actions, dock);
    head.oncontextmenu = (e) => { if (!e.target.closest('button')) tw.contextMenu(e, { pin: false }); };
    const body = el('div', 'popout-body');
    root.append(head, body);
    const menuHost = el('div'); menuHost.id = 'menuHost';
    const dialogHost = el('div'); dialogHost.id = 'dialogHost';
    doc.body.append(root, menuHost, dialogHost);
    open.set(tw.id, p);
    tw.leaveArea();
    body.appendChild(tw.container);
    tw.popout = {
      win,
      focus: () => { lastWin = win; win.focus(); },
      reveal: () => { if (doc.visibilityState === 'hidden') win.focus(); },
      focused: () => lastWin === win,
      renderActions: () => renderActions(p),
    };
    renderActions(p);
    track(win);
    ide.keymap.listenIn(win);
    ide.util.rehomeObservers();
    win.addEventListener('pagehide', () => returned(tw, p));
    remember(tw.id, { open: true });
    ide.emit('panelMoved', { id: tw.id, window: win });
    ide.emit('toolWindowShown', tw.id);
    if (focus) tw.popout.focus();
    else focusMain();
    return true;
  }

  // The panel window is closing (its X, Return to Main Window, the main page leaving): the panel goes back to its area.
  function returned(tw, p) {
    if (open.get(tw.id) !== p) return;
    open.delete(tw.id);
    if (lastWin === p.win) lastWin = window;
    p.unmirror();
    const popup = p.win.document.getElementById('popup');
    if (popup) document.body.appendChild(popup);
    tw.popout = null;
    tw.returnToArea();
    ide.util.rehomeObservers();
    if (!leaving) remember(tw.id, { open: false });
    ide.emit('panelMoved', { id: tw.id, window });
  }

  function dockBack(tw, { show = true } = {}) {
    const p = open.get(tw.id);
    if (!p) return;
    returned(tw, p);
    p.win.close();
    focusMain();
    if (show) tw.show();
  }

  function focusMain() {
    lastWin = window;
    window.focus();
  }

  // Code's tool windows belong to a project: with none open they go back for now and come out again with the next.
  async function restore() {
    if (!ide.root) return;
    let any = false;
    for (const [id, s] of Object.entries(saved())) {
      const tw = ide.toolWindows.get(id);
      if (s?.open === true && tw && !tw.popout && tw.available()) any = (await popOut(tw, { focus: false })) || any;
    }
    if (any) focusMain();
  }
  function closeAll() {
    for (const p of [...open.values()]) { returned(p.tw, p); p.win.close(); }
  }
  ide.on('projectClosed', () => { leaving = true; closeAll(); leaving = false; });
  ide.on('projectOpened', () => { if (window.__ideReady) setTimeout(restore); });
  addEventListener('pagehide', () => { leaving = true; closeAll(); });

  // ---------- menus and actions ----------
  const menuItem = (tw) => (tw.popout
    ? { label: tr('Return to Main Window'), icon: 'back', run: () => dockBack(tw) }
    : offered(tw) && { label: tr('Open Panel in New Window'), icon: 'externalLink', disabled: !ide.root, run: () => popOut(tw) });
  const attached = () => [...ide.toolWindows.values()].filter((tw) => !tw.popout && tw.available() && offered(tw)).sort((a, b) => a.order - b.order);
  const toolItem = (tw) => ({ label: tw.title, icon: tw.iconName, value: tw });
  ide.registerAction({
    id: 'PopoutToolWindow', title: tr('Open Tool Window in New Window…'), needsProject: true,
    run: async () => {
      const focused = attached().find((tw) => tw.container.contains(document.activeElement));
      const tw = focused || await ide.ui.pick({ placeholder: tr('Open Tool Window in New Window…'), items: attached().map(toolItem) });
      if (tw) popOut(tw);
    },
  });
  ide.registerAction({
    id: 'DockToolWindow', title: tr('Return Tool Window to Main Window…'), needsProject: true,
    run: async () => {
      const list = [...open.values()].map((p) => p.tw);
      const here = list.find((tw) => tw.popout.focused());
      const tw = here || (list.length === 1 ? list[0] : await ide.ui.pick({ placeholder: tr('Return Tool Window to Main Window…'), items: list.map(toolItem) }));
      if (tw) dockBack(tw);
    },
  });

  ide.popout = {
    open: (id, opts) => { const tw = ide.toolWindows.get(id); return !!tw && popOut(tw, opts); },
    close: (id) => { const tw = ide.toolWindows.get(id); if (tw?.popout) dockBack(tw, { show: false }); },
    isOpen: (id) => open.has(id),
    windowOf: (id) => open.get(id)?.win || null,
    windows: () => [...open.values()].map((p) => p.win),
    activeWindow: () => (usable(lastWin) ? lastWin : window),
    focusMain,
    menuItem,
    restore,
  };
})();
