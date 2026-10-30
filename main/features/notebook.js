const fs = require('fs');
const path = require('path');
const colab = require('../notebook/colab');
const { withEnvFiles } = require('../dotenv');

// Starts one kernel bridge (renderer/features/notebook/kernel_bridge.py) per open notebook in the project interpreter.
// The bridge speaks JSON lines over stdin/stdout, so the renderer drives it through ide.proc like any other process.
// Python runs the scripts from the unpacked copy in packaged builds; it cannot read app.asar.
// A notebook on a Colab runtime runs main/notebook/colab-bridge.js instead (the IDE's Electron as Node), which speaks
// the same lines to the runtime's Jupyter server; colab:* finds, makes and releases the runtimes (main/notebook/colab.js).
exports.register = ({ ipcMain, startProcess, appDir, unpackedDir = appDir }) => {
  const script = path.join(unpackedDir, 'renderer', 'features', 'notebook', 'kernel_bridge.py');
  ipcMain.handle('notebook:start', (_e, interp, cwd, paths = []) =>
    startProcess(interp.cmd, [...interp.args, '-u', script, cwd, ...paths], { cwd, env: { PYTHONIOENCODING: 'utf-8' } }));
  ipcMain.handle('notebook:startColab', (_e, cwd) =>
    startProcess(process.execPath, [path.join(unpackedDir, 'main', 'notebook', 'colab-bridge.js')], { cwd, windowsHide: true, env: { ELECTRON_RUN_AS_NODE: '1' } }));
  // IPC passes on only an error's message, so the code rides in front of it: "{NOT_FOUND} Colab: ...".
  const handle = (channel, fn) => ipcMain.handle(channel, async (...a) => {
    try { return await fn(...a); } catch (err) { throw new Error(err.code ? `{${err.code}} ${err.message}` : err.message); }
  });
  // Runtimes the notebooks asked for, until released: a runtime uses the account's Colab compute while assigned.
  const owned = new Set();
  const releasing = new Set();
  const release = (name) => {
    owned.delete(name);
    forget(name);
    const p = colab.release(name).finally(() => releasing.delete(p));
    releasing.add(p);
    return p;
  };
  // By notebook path, in userData/colab.json: the runtime a notebook keeps after it closes (Keep the Runtime), found
  // again with its kernel when the notebook reopens, even after a restart; and the .env secrets each notebook was
  // allowed to read through google.colab.userdata.
  const { app, dialog, BrowserWindow } = require('electron');
  const storeFile = () => path.join(app.getPath('userData'), 'colab.json');
  const keyOf = (file) => (process.platform === 'win32' ? path.resolve(file).toLowerCase() : path.resolve(file));
  let store = null;
  const load = () => {
    if (!store) {
      try { store = JSON.parse(fs.readFileSync(storeFile(), 'utf8')); } catch { store = {}; }
      store.kept = store.kept || {};
      store.secrets = store.secrets || {};
    }
    return store;
  };
  const save = () => {
    try { fs.mkdirSync(path.dirname(storeFile()), { recursive: true }); fs.writeFileSync(storeFile(), JSON.stringify(store, null, 1)); } catch { /* kept for this session only */ }
  };
  function forget(name) {
    const kept = load().kept;
    let changed = false;
    for (const [k, b] of Object.entries(kept)) if (b.name === name) { delete kept[k]; changed = true; }
    if (changed) save();
  }
  handle('colab:kept', (_e, nb) => load().kept[keyOf(nb)] || null);
  // binding {name, key, kernelId, owned}, or null to stop keeping it: a runtime the notebook asked for is then
  // released with it again.
  handle('colab:keep', (_e, nb, binding) => {
    const kept = load().kept;
    const k = keyOf(nb);
    if (binding) {
      kept[k] = { name: String(binding.name), key: binding.key || null, kernelId: binding.kernelId || null, owned: !!binding.owned };
      owned.delete(kept[k].name);
    } else {
      if (kept[k]?.owned) owned.add(kept[k].name);
      delete kept[k];
    }
    save();
  });
  // A secret is a key of the project's .env; the notebook reads it only once the user allowed it for that notebook.
  handle('colab:secret', (_e, nb, root, key) => {
    const env = root ? withEnvFiles({}, undefined, root) : {};
    if (!Object.prototype.hasOwnProperty.call(env, key)) return { exists: false };
    if (!(load().secrets[keyOf(nb)] || []).includes(key)) return { exists: true, access: false };
    return { exists: true, access: true, payload: env[key] };
  });
  handle('colab:grantSecret', (_e, nb, key) => {
    const list = load().secrets[keyOf(nb)] ||= [];
    if (!list.includes(key)) list.push(String(key));
    save();
  });
  handle('colab:pickFiles', async (e, defaultPath) => {
    const r = await dialog.showOpenDialog(BrowserWindow.fromWebContents(e.sender), { properties: ['openFile', 'multiSelections'], defaultPath });
    return r.canceled ? [] : r.filePaths;
  });
  handle('colab:status', () => colab.status());
  handle('colab:gcloud', () => !!colab.findGcloud());
  handle('colab:signIn', (e) => colab.signIn({ onUrl: (url) => { if (!e.sender.isDestroyed()) e.sender.send('colab:signInUrl', url); } }));
  handle('colab:cancelSignIn', () => colab.cancelSignIn());
  handle('colab:specs', () => colab.specs());
  handle('colab:runtimes', () => colab.runtimes());
  handle('colab:create', async (_e, key) => { const rt = await colab.create(key); owned.add(rt.name); return rt; });
  handle('colab:get', (_e, name) => colab.get(name));
  handle('colab:release', (_e, name) => release(name));
  // Quitting with notebooks on runtimes they asked for gives those back first (a window's own release may still be on
  // its way), for at most 10 seconds. gcloud waits on localhost for the browser's answer: an unfinished sign-in ends
  // with the IDE.
  let released = false;
  app.on('will-quit', (e) => {
    colab.cancelSignIn();
    if (released || !owned.size && !releasing.size) return;
    e.preventDefault();
    released = true;
    const pending = [...[...owned].map((name) => release(name)), ...releasing].map((p) => p.catch(() => {}));
    Promise.race([Promise.all(pending), new Promise((r) => setTimeout(r, 10000))]).then(() => app.quit());
  });
};
