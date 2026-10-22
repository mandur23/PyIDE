// Paste from History (clipboard-history plugin): keeps the history across restarts only when the user turns on
// Settings › Editor › Clipboard › "Keep the clipboard history after a restart" (off by default: copied text can hold
// passwords and tokens). It is then written to <userData>/clipboard-history.bin, encrypted with safeStorage (Windows
// DPAPI, readable only by this user on this computer), and deleted when the setting is turned off. Settings export
// never reads it.
const fs = require('fs');
const path = require('path');
const { safeStorage } = require('electron');

const MAX_ITEMS = 100;
const MAX_TEXT = 1024 * 1024;

const clean = (list) => (Array.isArray(list) ? list : [])
  .filter((i) => i && typeof i.text === 'string' && i.text && i.text.length <= MAX_TEXT)
  .slice(0, MAX_ITEMS)
  .map((i) => ({
    text: i.text,
    time: Number(i.time) || 0,
    ...(Array.isArray(i.multicursor) && i.multicursor.every((t) => typeof t === 'string') ? { multicursor: i.multicursor } : {}),
    ...(i.wholeLine === true ? { wholeLine: true } : {}),
  }));

exports.register = (ctx) => {
  const file = path.join(ctx.app.getPath('userData'), 'clipboard-history.bin');
  const encrypted = () => safeStorage.isEncryptionAvailable();

  ctx.ipcMain.handle('clipboard-history:load', () => {
    if (!encrypted()) return [];
    try { return clean(JSON.parse(safeStorage.decryptString(fs.readFileSync(file)))); } catch { return []; }
  });
  // Without encryption nothing is written: the history stays session-only.
  ctx.ipcMain.handle('clipboard-history:save', (_e, items) => {
    if (!encrypted()) return false;
    const tmp = `${file}.tmp`;
    fs.writeFileSync(tmp, safeStorage.encryptString(JSON.stringify(clean(items))));
    fs.renameSync(tmp, file);
    return true;
  });
  ctx.ipcMain.handle('clipboard-history:clear', () => { fs.rmSync(file, { force: true }); return true; });
  ctx.ipcMain.handle('clipboard-history:stored', () => fs.existsSync(file));
};
