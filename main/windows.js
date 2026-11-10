// The main IDE window plus detached editor windows ("Open in New Window"). Windows edit the same documents: edits,
// saves, renames and deletes are relayed between them, and closing asks about unsaved changes and running programs
// (Run sessions, Craft servers) first (closing the main window asks once about every window's, since it closes them all). Before the main window, the start chooser may ask
// which app mode the process runs in (main.js).
const { BrowserWindow, dialog, ipcMain } = require('electron');
const fs = require('fs');
const path = require('path');
const { pathToFileURL } = require('url');
const { pathKey, caseSensitiveDirs } = require('./path-case');
const { createSharedDocs, loadFromDisk } = require('./shared-docs');

// product: the app's name (package.json productName), which the window titles carry. devToolsKey: F12 opens DevTools
// (a run from the source folder); with no application menu (main.js) nothing else does.
function createWindowManager({ appDir, product = 'Nano Studio', devToolsKey = false }) {
  const all = new Set();
  // A guest's document no window holds is read as the editor would read it.
  const sharedDocs = createSharedDocs({ keyOf: pathKey, load: loadFromDisk });
  const initialState = new Map(); // webContents id -> payload for a detached window
  const dirty = new Map(); // webContents id -> paths of its modified documents
  const busy = new Map(); // webContents id -> names of what runs in it (the run plugin's sessions), stopped by closing
  let main = null;
  let mode = 'code'; // the process's app mode, which every window's page is told (?mode=)
  let closingAll = false; // the user answered for every window: close them without asking again
  // A page asked about closing says it got the question (window:closeAsked). One that does not within ANSWER_MS has
  // crashed, hangs or never loaded its IDE, and could otherwise not be closed at all: it is asked natively instead.
  const ANSWER_MS = 4000;
  const asking = new Map(); // webContents id -> {timer} while the page has not answered, {abort} while asked natively
  const langs = new Map(); // webContents id -> the language its page loaded (core:localeSync)

  const alive = () => [...all].filter((w) => !w.isDestroyed());
  const others = (sender) => alive().filter((w) => w.webContents.id !== sender.id);
  const dirtyPaths = (w) => dirty.get(w.webContents.id) || [];
  const busyNames = (w) => busy.get(w.webContents.id) || [];
  // Before the page sees the key: plain F12 is no shortcut of any mode.
  const addDevToolsKey = (w) => {
    if (!devToolsKey) return;
    w.webContents.on('before-input-event', (e, input) => {
      if (input.type !== 'keyDown' || input.key !== 'F12' || input.control || input.shift || input.alt || input.meta) return;
      e.preventDefault();
      w.webContents.toggleDevTools();
    });
  };
  const announcePeers = () => {
    const n = alive().length;
    for (const w of alive()) w.webContents.send('window:peers', n);
  };

  function create({ detached = false, query = {}, bounds = {} } = {}) {
    const w = new BrowserWindow({
      width: bounds.width || (detached ? 1000 : 1400),
      height: bounds.height || (detached ? 760 : 900),
      x: bounds.x,
      y: bounds.y,
      backgroundColor: '#1e1f22',
      title: `${product} ${{ craft: 'Craft', cut: 'Cut' }[mode] || 'Code'}`,
      // The preload hands the IPC API only to the IDE page (--pyide-page); the renderer process runs in Chromium's sandbox.
      webPreferences: {
        preload: path.join(appDir, 'preload.js'), contextIsolation: true, sandbox: true,
        additionalArguments: [`--pyide-page=${pathToFileURL(path.join(appDir, 'renderer', 'index.html')).href}`],
      },
    });
    all.add(w);
    addDevToolsKey(w);
    const id = w.webContents.id;
    w.on('close', (e) => {
      if (closingAll) return;
      const elsewhere = w === main ? others(w.webContents).flatMap(dirtyPaths) : [];
      const running = [...busyNames(w), ...(w === main ? others(w.webContents).flatMap(busyNames) : [])];
      if (!dirtyPaths(w).length && !elsewhere.length && !running.length) return;
      e.preventDefault();
      if (asking.has(id)) return;
      if (w.webContents.isCrashed()) return void askNatively(w, { crashed: true, elsewhere, running });
      w.webContents.send('window:confirmClose', { others: elsewhere, running });
      asking.set(id, { timer: setTimeout(() => askNatively(w, { elsewhere, running }), ANSWER_MS) });
    });
    w.on('closed', () => {
      all.delete(w);
      initialState.delete(id);
      dirty.delete(id);
      busy.delete(id);
      answered(id);
      langs.delete(id);
      leaveAll(id);
      if (w === main) {
        main = null;
        closingAll = true;
        for (const other of alive()) other.close();
      }
      announcePeers();
    });
    w.webContents.on('did-finish-load', announcePeers);
    const page = { ...query, mode, product };
    w.loadFile(path.join(appDir, 'renderer', 'index.html'), { query: detached ? { ...page, detached: '1' } : page });
    return w;
  }

  function answered(id) {
    const a = asking.get(id);
    if (!a) return;
    asking.delete(id);
    clearTimeout(a.timer);
    a.abort?.abort();
  }
  ipcMain.on('window:closeAsked', (e) => answered(e.sender.id));
  // Cancel in a close question, the page's or the native one: a quit or restart waiting on the window is called off.
  // Not an ipcMain.emit for the native one: main/ipc-guard.js refuses a message that no app page sent.
  const cancelListeners = new Set();
  const closeCancelled = () => { for (const fn of cancelListeners) fn(); };
  ipcMain.on('window:closeCancelled', closeCancelled);
  ipcMain.on('core:localeSync', (e, lang) => { langs.set(e.sender.id, lang); });
  // The page's own words in its language (renderer/locales); the page that would translate them cannot.
  const translator = (id) => {
    const lang = langs.get(id);
    let dict = {};
    if (typeof lang === 'string' && /^[a-z]{2,3}(-[A-Za-z]{2,4})?$/.test(lang)) {
      try { dict = JSON.parse(fs.readFileSync(path.join(appDir, 'renderer', 'locales', `${lang}.json`), 'utf8')); } catch {}
    }
    return (text) => (typeof dict[text] === 'string' ? dict[text] : text);
  };
  async function askNatively(w, { crashed = false, elsewhere = [], running = [] }) {
    if (w.isDestroyed()) return;
    const id = w.webContents.id;
    const abort = new AbortController();
    asking.set(id, { abort });
    const tr = translator(id);
    const paths = [...dirtyPaths(w), ...elsewhere];
    const detail = [
      paths.length ? `${tr('Unsaved changes in these files will be lost:')}\n${paths.join('\n')}` : '',
      running.length ? `${tr('These are still running. Closing stops them:')}\n${running.join('\n')}` : '',
    ].filter(Boolean).join('\n\n');
    const { response } = await dialog.showMessageBox(w, {
      type: 'warning', title: product, noLink: true, signal: abort.signal, detail,
      message: crashed ? tr('This window stopped working.') : tr('This window is not responding.'),
      buttons: [tr('Close Anyway'), tr('Cancel')], defaultId: 1, cancelId: 1,
    });
    // The page answered after all: its own dialog asks.
    if (asking.get(id)?.abort !== abort) return;
    asking.delete(id);
    if (w.isDestroyed()) return;
    if (response !== 0) return void closeCancelled();
    dirty.delete(id);
    busy.delete(id);
    if (w === main) closingAll = true;
    // Not close(): a hung page would hold that too, in its beforeunload.
    w.destroy();
  }

  // The start chooser (renderer/chooser.html): a frameless window with a Dock of the modes. Resolves the mode picked, or
  // null when it was closed (Esc, its close button). It stays open until closeChooser, so the app does not quit for
  // having no window while the main window is being created. updates: {state(), update()} for its update icon, or null.
  let chooser = null;
  function choose(updates) {
    const page = path.join(appDir, 'renderer', 'chooser.html');
    return new Promise((resolve) => {
      const w = new BrowserWindow({
        width: 860, height: 540, frame: false, resizable: false, maximizable: false, fullscreenable: false, show: false,
        backgroundColor: '#101a33', title: product,
        // The preload gives this page only the chooser's calls (--pyide-chooser).
        webPreferences: {
          preload: path.join(appDir, 'preload.js'), contextIsolation: true, sandbox: true,
          additionalArguments: [`--pyide-chooser=${pathToFileURL(page).href}`],
        },
      });
      chooser = w;
      addDevToolsKey(w);
      const mine = (e) => e.sender === w.webContents;
      const onPick = (e, picked) => { if (mine(e) && ['code', 'craft', 'cut'].includes(picked)) resolve(picked); };
      const onClose = (e) => { if (mine(e)) w.close(); };
      const onUpdateState = (e) => { e.returnValue = mine(e) ? updates?.state() ?? null : null; };
      const onUpdate = (e) => { if (mine(e)) updates?.update(); };
      ipcMain.on('chooser:pick', onPick);
      ipcMain.on('chooser:close', onClose);
      ipcMain.on('chooser:updateState', onUpdateState);
      ipcMain.on('chooser:update', onUpdate);
      w.once('ready-to-show', () => w.show());
      w.on('closed', () => {
        ipcMain.removeListener('chooser:pick', onPick);
        ipcMain.removeListener('chooser:close', onClose);
        ipcMain.removeListener('chooser:updateState', onUpdateState);
        ipcMain.removeListener('chooser:update', onUpdate);
        if (chooser === w) chooser = null;
        resolve(null);
      });
      w.loadFile(page, { query: { product } });
    });
  }

  ipcMain.handle('window:openDetached', (e, payload) => {
    const parent = BrowserWindow.fromWebContents(e.sender);
    const b = parent?.getBounds();
    const w = create({ detached: true, bounds: b ? { x: b.x + 60, y: b.y + 60 } : {} });
    initialState.set(w.webContents.id, payload);
    return w.webContents.id;
  });
  ipcMain.handle('window:initialState', (e) => initialState.get(e.sender.id) || null);
  ipcMain.handle('window:isDetached', (e) => e.sender.id !== main?.webContents.id);
  // Tabs sent back from a detached window open in the main window.
  ipcMain.handle('window:dockToMain', (_e, payload) => {
    if (!main || main.isDestroyed()) return false;
    main.webContents.send('window:dock', payload);
    main.focus();
    return true;
  });
  ipcMain.on('window:setDirty', (e, paths) => dirty.set(e.sender.id, Array.isArray(paths) ? paths : []));
  ipcMain.on('window:setBusy', (e, names) => busy.set(e.sender.id, Array.isArray(names) ? names.map(String) : []));
  // Closes the window without asking (the user answered); from the main window, every window.
  ipcMain.handle('window:closeNow', (e) => {
    dirty.delete(e.sender.id);
    busy.delete(e.sender.id);
    if (e.sender.id === main?.webContents.id) closingAll = true;
    BrowserWindow.fromWebContents(e.sender)?.close();
  });
  // The main window's Save All for files open only in other windows: each saves its own and answers. -> true when no
  // window has unsaved files left (one that could not save shows its error).
  const pendingSaves = new Map();
  let saveSeq = 0;
  ipcMain.handle('window:saveOthers', async (e) => {
    const targets = others(e.sender).filter((w) => dirtyPaths(w).length);
    await Promise.all(targets.map((w) => new Promise((resolve) => {
      const id = ++saveSeq;
      // A window that never answers (hung) does not hold the main window's dialog forever.
      const timer = setTimeout(() => { pendingSaves.delete(id); resolve(); }, 30000);
      pendingSaves.set(id, () => { clearTimeout(timer); resolve(); });
      w.webContents.send('window:saveAll', id);
    })));
    return targets.every((w) => w.isDestroyed() || !dirtyPaths(w).length);
  });
  ipcMain.on('window:saved', (_e, id) => { pendingSaves.get(id)?.(); pendingSaves.delete(id); });
  // Close as the title bar's X does (asks about unsaved files): a sandboxed page's window.close() is ignored for a
  // window that no script opened.
  ipcMain.handle('window:close', (e) => { BrowserWindow.fromWebContents(e.sender)?.close(); });
  ipcMain.handle('window:setTitle', (e, title) => BrowserWindow.fromWebContents(e.sender)?.setTitle(title));

  // Saves ({path, text, encoding}) and renames or deletes ({from, to}) are told to the other windows.
  for (const channel of ['doc:saved', 'doc:moved']) {
    ipcMain.on(channel, (e, msg) => {
      for (const w of others(e.sender)) w.webContents.send(channel, msg);
    });
  }

  // ---------- shared documents ----------
  // One order of edits for a file open in several windows (main/shared-docs.js). Keyed like the renderer's documents
  // (main/path-case.js): a window asks about a document's folder before it joins. A collaboration session (main/collab)
  // adds its guests to the same documents.
  ipcMain.handle('fs:caseSensitiveDirs', (_e, folder) => caseSensitiveDirs(folder));
  const sender = (wc) => (channel, msg) => { if (!wc.isDestroyed()) wc.send(channel, msg); };
  // A document that is not a file here (a collaboration guest's collab:// document, main/features/collab.js) goes to
  // the route that owns its path: {owns(path), join(wc, msg, reply), op(wc, msg), leave(wc, msg)}.
  const routes = [];
  const routeOf = (p) => routes.find((r) => r.owns(p));
  ipcMain.on('doc:join', (e, { path: p, ticket }) => {
    const r = routeOf(p);
    if (r) return r.join(e.sender, { path: p, ticket }, sender(e.sender));
    return sharedDocs.join(e.sender.id, p, sender(e.sender), { ticket });
  });
  ipcMain.on('doc:snapshot', (e, msg) => { if (!routeOf(msg?.path)) sharedDocs.snapshot(e.sender.id, msg); });
  ipcMain.on('doc:op', (e, msg) => { const r = routeOf(msg?.path); if (r) r.op(e.sender, msg); else sharedDocs.op(e.sender.id, msg); });
  ipcMain.on('doc:leave', (e, { path: p }) => { const r = routeOf(p); if (r) r.leave(e.sender, { path: p }); else sharedDocs.leave(e.sender.id, p); });
  function leaveAll(id) { sharedDocs.leaveAll(id); }

  return {
    createMain(query, appMode = 'code') { mode = appMode; main = create({ query }); return main; },
    main: () => main,
    sharedDocs,
    routeDocs(route) { routes.push(route); },
    choose,
    closeChooser() { if (chooser && !chooser.isDestroyed()) chooser.destroy(); },
    toChooser(channel, payload) { if (chooser && !chooser.isDestroyed()) chooser.webContents.send(channel, payload); },
    // What closing every window would stop, by name (the update asks about it before its installer quits the app).
    running: () => alive().flatMap(busyNames),
    // on: the user has answered for every window (Restart to Update), so they close without asking.
    closeWithoutAsking(on) { closingAll = !!on; },
    onCloseCancelled(fn) { cancelListeners.add(fn); },
  };
}

module.exports = { createWindowManager };
