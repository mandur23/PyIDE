// Settings sync plugin, main side: File › Manage IDE Settings › Export Settings… / Import Settings… (PyCharm's).
// The archive format and what goes into it are in main/settings-sync/archive.js.
//
// Paths: export and import only take a file the Save or Open dialog of this module returned in this session, so a
// renderer cannot make main write or read an arbitrary path. Tests answer the dialogs through PYIDE_SETTINGS_SYNC_DIALOG,
// a JSON file {save?, open?} read at each dialog (only when that variable is set).
const fs = require('fs');
const path = require('path');
const { dialog, BrowserWindow } = require('electron');
const archive = require('../settings-sync/archive');

exports.register = ({ ipcMain, app, diagnostics }) => {
  const log = diagnostics.logger('#settings-sync');
  const userData = app.getPath('userData');
  const chosen = { save: new Set(), open: new Set() };
  const keyOf = (p) => path.resolve(p).toLowerCase();
  const allowed = (kind, file) => typeof file === 'string' && chosen[kind].has(keyOf(file));

  const stubbed = (kind) => {
    const f = process.env.PYIDE_SETTINGS_SYNC_DIALOG;
    if (!f) return undefined;
    try { return JSON.parse(fs.readFileSync(f, 'utf8'))[kind] ?? null; } catch { return null; }
  };
  const remember = (kind, file) => {
    if (!file) return null;
    chosen[kind].add(keyOf(file));
    return file;
  };

  ipcMain.handle('settings:chooseExportFile', async (e, title) => {
    let file = stubbed('save');
    if (file === undefined) {
      const r = await dialog.showSaveDialog(BrowserWindow.fromWebContents(e.sender), {
        title: String(title || 'Export Settings'),
        defaultPath: path.join(app.getPath('home'), 'settings.zip'),
        filters: [{ name: 'ZIP', extensions: ['zip'] }],
      });
      file = r.canceled ? null : r.filePath;
    }
    if (file && !/\.zip$/i.test(file)) file += '.zip';
    return remember('save', file);
  });

  ipcMain.handle('settings:chooseImportFile', async (e, title) => {
    let file = stubbed('open');
    if (file === undefined) {
      const r = await dialog.showOpenDialog(BrowserWindow.fromWebContents(e.sender), {
        title: String(title || 'Import Settings'),
        defaultPath: app.getPath('home'),
        properties: ['openFile'],
        filters: [{ name: 'ZIP', extensions: ['zip'] }],
      });
      file = r.canceled ? null : r.filePaths[0];
    }
    return remember('open', file);
  });

  // Errors cross IPC as {ok: false, code, detail, version?, format?, size?, limit?, count?}; the renderer words them.
  const failure = (err) => {
    if (!(err instanceof archive.ZipError)) log.warn(err.stack || err.message);
    return { ok: false, code: err.code && err instanceof archive.ZipError ? err.code : 'failed', detail: err.message, version: err.version, format: err.format, size: err.size, limit: err.limit, count: err.count };
  };
  const notChosen = { ok: false, code: 'notChosen', detail: 'the file was not chosen in the dialog' };

  ipcMain.handle('settings:exportInfo', () => archive.summary(userData));

  ipcMain.handle('settings:export', (_e, file, categories) => {
    if (!allowed('save', file)) return notChosen;
    try {
      const manifest = archive.writeArchive(file, userData, Array.isArray(categories) ? categories : [], { version: app.getVersion() });
      log.info(`settings exported to ${file}: ${Object.keys(manifest.categories).join(', ')}`);
      return { ok: true, file, categories: Object.keys(manifest.categories) };
    } catch (err) { return failure(err); }
  });

  ipcMain.handle('settings:inspect', (_e, file) => {
    if (!allowed('open', file)) return notChosen;
    try { return { ok: true, ...archive.inspect(file) }; } catch (err) { return failure(err); }
  });

  // One import at a time: apply() inflates asynchronously, so a second request could otherwise interleave with it.
  let importing = false;
  ipcMain.handle('settings:import', async (_e, file, categories, opts = {}) => {
    if (!allowed('open', file)) return notChosen;
    if (importing) return { ok: false, code: 'busy', detail: 'another import is running' };
    importing = true;
    try {
      const r = await archive.apply(userData, file, Array.isArray(categories) ? categories : [], { databaseLoaded: !!opts.databaseLoaded, version: app.getVersion() });
      log.info(`settings imported from ${file}: ${r.applied.join(', ')}; backup ${r.backup}`);
      return { ok: true, ...r };
    } catch (err) { return failure(err); } finally { importing = false; }
  });
};
