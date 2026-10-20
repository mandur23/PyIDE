// The main IDE window plus detached editor windows ("Open in New Window"). Windows edit the same documents:
// unsaved text and save state are relayed between them, and a window with unsaved changes asks before closing.
const { BrowserWindow, ipcMain } = require('electron');
const path = require('path');
const { pathToFileURL } = require('url');

function createWindowManager({ appDir }) {
  const all = new Set();
  const initialState = new Map(); // webContents id -> payload for a detached window
  const dirty = new Map(); // webContents id -> bool
  let main = null;

  const alive = () => [...all].filter((w) => !w.isDestroyed());
  const others = (sender) => alive().filter((w) => w.webContents.id !== sender.id);
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
      if (!dirty.get(id)) return;
      e.preventDefault();
      w.webContents.send('window:confirmClose');
    });
    w.on('closed', () => {
      all.delete(w);
      initialState.delete(id);
      dirty.delete(id);
      if (w === main) {
        main = null;
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
  ipcMain.on('window:setDirty', (e, value) => dirty.set(e.sender.id, !!value));
  ipcMain.handle('window:closeNow', (e) => {
    dirty.delete(e.sender.id);
    BrowserWindow.fromWebContents(e.sender)?.close();
  });
  ipcMain.handle('window:setTitle', (e, title) => BrowserWindow.fromWebContents(e.sender)?.setTitle(title));

  // Document sync: {path, text} for edits, {path, text} for saves, {path} when a window opens a document.
  for (const channel of ['doc:changed', 'doc:saved', 'doc:opened']) {
    ipcMain.on(channel, (e, msg) => {
      for (const w of others(e.sender)) w.webContents.send(channel, msg);
    });
  }

  return {
    createMain(query) { main = create({ query }); return main; },
    main: () => main,
  };
}

module.exports = { createWindowManager };
