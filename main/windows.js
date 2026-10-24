// The main IDE window plus detached editor windows ("Open in New Window"). Windows edit the same documents: edits,
// saves, renames and deletes are relayed between them, and closing asks about unsaved changes first (closing the main
// window asks once about every window's, since it closes them all).
const { BrowserWindow, ipcMain } = require('electron');
const path = require('path');
const { pathToFileURL } = require('url');

function createWindowManager({ appDir }) {
  const all = new Set();
  const initialState = new Map(); // webContents id -> payload for a detached window
  const dirty = new Map(); // webContents id -> paths of its modified documents
  let main = null;
  let closingAll = false; // the user answered for every window: close them without asking again

  const alive = () => [...all].filter((w) => !w.isDestroyed());
  const others = (sender) => alive().filter((w) => w.webContents.id !== sender.id);
  const dirtyPaths = (w) => dirty.get(w.webContents.id) || [];
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
      title: 'PyIDE',
      autoHideMenuBar: true,
      // The preload hands the IPC API only to the IDE page (--pyide-page); the renderer process runs in Chromium's sandbox.
      webPreferences: {
        preload: path.join(appDir, 'preload.js'), contextIsolation: true, sandbox: true,
        additionalArguments: [`--pyide-page=${pathToFileURL(path.join(appDir, 'renderer', 'index.html')).href}`],
      },
    });
    all.add(w);
    const id = w.webContents.id;
    w.on('close', (e) => {
      if (closingAll) return;
      const elsewhere = w === main ? others(w.webContents).flatMap(dirtyPaths) : [];
      if (!dirtyPaths(w).length && !elsewhere.length) return;
      e.preventDefault();
      w.webContents.send('window:confirmClose', { others: elsewhere });
    });
    w.on('closed', () => {
      all.delete(w);
      initialState.delete(id);
      dirty.delete(id);
      leaveAll(id);
      if (w === main) {
        main = null;
        closingAll = true;
        for (const other of alive()) other.close();
      }
      announcePeers();
    });
    w.webContents.on('did-finish-load', announcePeers);
    w.loadFile(path.join(appDir, 'renderer', 'index.html'), { query: detached ? { ...query, detached: '1' } : query });
    return w;
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
  // Closes the window without asking (the user answered); from the main window, every window.
  ipcMain.handle('window:closeNow', (e) => {
    dirty.delete(e.sender.id);
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
  // A document open in one window is that window's alone. Once a second window opens it, this process holds the shared
  // text and numbers the edits: an edit made on the current revision is applied and sent to every window holding the
  // document (to its sender as the confirmation); one made on an older revision is refused, and its window sends it
  // again shifted past the edits it had not seen yet (renderer/core/editors.js). One order, so every window ends with
  // the same text.
  const shared = new Map(); // lower-cased path -> {holders: Set of webContents ids, waiting: Set, rev, text | null}
  const docKey = (p) => String(p).toLowerCase();
  const sendTo = (id, channel, msg) => alive().find((w) => w.webContents.id === id)?.webContents.send(channel, msg);
  const applyOps = (text, ops) => ops.reduce((t, op) => {
    let out = '';
    let i = 0;
    for (const c of op.c) { out += t.slice(i, c.at) + c.ins; i = c.at + c.del; }
    return out + t.slice(i);
  }, text);

  // The holder hands over the text when a second window joins; windows that join meanwhile wait for it.
  function askHolder(s, path) {
    const holder = [...s.holders][0];
    if (holder !== undefined) return sendTo(holder, 'doc:share', { path });
    const first = [...s.waiting][0];
    if (first === undefined) return;
    s.waiting.delete(first);
    s.holders.add(first);
    sendTo(first, 'doc:synced', { path, rev: s.rev, shared: false });
    if (s.waiting.size) askHolder(s, path);
  }
  ipcMain.on('doc:join', (e, { path: p }) => {
    const k = docKey(p);
    const s = shared.get(k) || shared.set(k, { holders: new Set(), waiting: new Set(), rev: 0, text: null }).get(k);
    const id = e.sender.id;
    if (s.holders.has(id)) return;
    if (!s.holders.size) {
      s.holders.add(id);
      e.sender.send('doc:synced', { path: p, rev: s.rev, shared: false });
    } else if (s.text !== null) {
      s.holders.add(id);
      e.sender.send('doc:synced', { path: p, rev: s.rev, text: s.text, shared: true });
    } else {
      s.waiting.add(id);
      if (s.waiting.size === 1) askHolder(s, p);
    }
  });
  ipcMain.on('doc:snapshot', (e, { path: p, rev, text }) => {
    const s = shared.get(docKey(p));
    if (!s || !s.holders.has(e.sender.id)) return;
    Object.assign(s, { rev, text });
    for (const id of s.waiting) {
      s.holders.add(id);
      sendTo(id, 'doc:synced', { path: p, rev, text, shared: true });
    }
    s.waiting.clear();
  });
  ipcMain.on('doc:op', (e, { path: p, base, ops }) => {
    const s = shared.get(docKey(p));
    if (!s || s.text === null || !s.holders.has(e.sender.id)) return;
    if (base !== s.rev) return void e.sender.send('doc:nack', { path: p });
    s.text = applyOps(s.text, ops);
    s.rev++;
    for (const id of s.holders) sendTo(id, 'doc:op', { path: p, rev: s.rev, ops, mine: id === e.sender.id });
  });
  function leave(k, id) {
    const s = shared.get(k);
    if (!s) return;
    const asked = [...s.holders][0] === id && s.waiting.size;
    s.holders.delete(id);
    s.waiting.delete(id);
    if (!s.holders.size && !s.waiting.size) return void shared.delete(k);
    if (asked) return askHolder(s, k);
    // Alone again: the last window keeps its own text and stops sending edits.
    if (s.holders.size === 1 && !s.waiting.size && s.text !== null) {
      s.text = null;
      const [last] = s.holders;
      sendTo(last, 'doc:unshared', { path: k });
    }
  }
  ipcMain.on('doc:leave', (e, { path: p }) => leave(docKey(p), e.sender.id));
  function leaveAll(id) { for (const k of [...shared.keys()]) leave(k, id); }

  return {
    createMain(query) { main = create({ query }); return main; },
    main: () => main,
  };
}

module.exports = { createWindowManager };
