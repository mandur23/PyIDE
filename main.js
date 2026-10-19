const { app, BrowserWindow, ipcMain, dialog, shell } = require('electron');
const path = require('path');
const fs = require('fs');
const { spawn, execFileSync } = require('child_process');
const { createPluginManager } = require('./main/plugin-manager');

if (process.env.PYIDE_USER_DATA) app.setPath('userData', process.env.PYIDE_USER_DATA);

const IGNORED = new Set(['.git', '__pycache__', 'node_modules', '.idea', '.mypy_cache', '.pytest_cache', '.ruff_cache']);

let win;
const procs = new Map();
let nextProcId = 1;

const send = (channel, payload) => win && !win.isDestroyed() && win.webContents.send(channel, payload);

// Spawns a child whose output streams to the renderer as proc:data / proc:exit, keyed by the returned id.
function startProcess(cmd, args, opts = {}) {
  const id = nextProcId++;
  const proc = spawn(cmd, args, {
    ...opts,
    env: { ...process.env, PYTHONIOENCODING: 'utf-8', PYTHONUNBUFFERED: '1', ...opts.env },
  });
  procs.set(id, proc);
  const forward = (stream) => (d) => send('proc:data', { id, stream, text: d.toString('utf8') });
  proc.stdout.on('data', forward('out'));
  proc.stderr.on('data', forward('err'));
  proc.on('error', (err) => send('proc:data', { id, stream: 'err', text: `${err.message}\n` }));
  proc.on('close', (code) => {
    procs.delete(id);
    send('proc:exit', { id, code });
  });
  return id;
}

function killProcess(id) {
  const proc = procs.get(id);
  if (proc) spawn('taskkill', ['/pid', String(proc.pid), '/T', '/F']);
}

function probeInterpreter(cmd, args) {
  try {
    const out = execFileSync(cmd, [...args, '-c', 'import sys,platform;print(platform.python_version());print(sys.executable)'],
      { encoding: 'utf8', timeout: 5000 }).trim().split(/\r?\n/);
    return { version: out[0], executable: out[1] };
  } catch {
    return null;
  }
}

ipcMain.handle('dialog:openFolder', async () => {
  const r = await dialog.showOpenDialog(win, { properties: ['openDirectory'] });
  return r.canceled ? null : r.filePaths[0];
});
ipcMain.handle('dialog:openFile', async (_e, filters) => {
  const r = await dialog.showOpenDialog(win, { properties: ['openFile'], filters });
  return r.canceled ? null : r.filePaths[0];
});

ipcMain.handle('fs:list', (_e, dir) =>
  fs.readdirSync(dir, { withFileTypes: true })
    .filter((d) => !IGNORED.has(d.name))
    .map((d) => ({ name: d.name, path: path.join(dir, d.name), dir: d.isDirectory() }))
    .sort((a, b) => (b.dir - a.dir) || a.name.localeCompare(b.name)));

ipcMain.handle('fs:walk', (_e, root) => {
  const out = [];
  const walk = (dir) => {
    for (const d of fs.readdirSync(dir, { withFileTypes: true })) {
      if (out.length >= 20000) return;
      if (IGNORED.has(d.name) || ['.venv', 'venv', 'env'].includes(d.name)) continue;
      const p = path.join(dir, d.name);
      if (d.isDirectory()) walk(p);
      else out.push(p);
    }
  };
  walk(root);
  return out;
});

ipcMain.handle('fs:exists', (_e, p) => fs.existsSync(p));
ipcMain.handle('fs:read', (_e, p) => fs.readFileSync(p, 'utf8'));
ipcMain.handle('fs:write', (_e, p, text) => fs.writeFileSync(p, text, 'utf8'));
ipcMain.handle('fs:create', (_e, p, isDir) => {
  if (fs.existsSync(p)) throw new Error(`${path.basename(p)} already exists`);
  if (isDir) fs.mkdirSync(p, { recursive: true });
  else fs.writeFileSync(p, '');
});
ipcMain.handle('fs:rename', (_e, from, to) => fs.renameSync(from, to));
ipcMain.handle('fs:trash', (_e, p) => shell.trashItem(p));

ipcMain.handle('py:interpreters', (_e, root, extraPaths = []) => {
  const found = [];
  const seen = new Set();
  const add = (cmd, args, label) => {
    const info = probeInterpreter(cmd, args);
    if (!info || seen.has(info.executable.toLowerCase())) return;
    seen.add(info.executable.toLowerCase());
    found.push({ cmd, args, label: `${label} (Python ${info.version})`, executable: info.executable, version: info.version });
  };
  if (root) {
    for (const venv of ['.venv', 'venv', 'env']) {
      const exe = path.join(root, venv, 'Scripts', 'python.exe');
      if (fs.existsSync(exe)) add(exe, [], venv);
    }
  }
  for (const p of extraPaths) if (fs.existsSync(p)) add(p, [], path.basename(path.dirname(path.dirname(p))) || p);
  add('py', ['-3'], 'py launcher');
  add('python', [], 'python');
  return found;
});

ipcMain.handle('proc:input', (_e, id, text) => procs.get(id)?.stdin.write(text));
ipcMain.handle('proc:closeInput', (_e, id) => procs.get(id)?.stdin.end());
ipcMain.handle('proc:kill', (_e, id) => killProcess(id));

const plugins = createPluginManager({ appDir: __dirname, userDataDir: app.getPath('userData') });

// Settings live in a file, not localStorage: a restart (app.exit) can drop localStorage writes that were not flushed yet.
const SETTINGS_FILE = path.join(app.getPath('userData'), 'settings.json');
ipcMain.on('settings:loadSync', (e) => {
  try { e.returnValue = JSON.parse(fs.readFileSync(SETTINGS_FILE, 'utf8')); } catch { e.returnValue = null; }
});
ipcMain.on('settings:saveSync', (e, settings) => {
  fs.mkdirSync(path.dirname(SETTINGS_FILE), { recursive: true });
  fs.writeFileSync(`${SETTINGS_FILE}.tmp`, JSON.stringify(settings, null, 2));
  fs.renameSync(`${SETTINGS_FILE}.tmp`, SETTINGS_FILE);
  e.returnValue = true;
});

ipcMain.handle('core:features', () => plugins.rendererEntries());
ipcMain.on('core:localeSync', (e, lang) => { e.returnValue = plugins.localeDictionary(lang); });
ipcMain.handle('core:relaunch', () => {
  app.relaunch();
  app.exit(0);
});
ipcMain.handle('plugins:list', () => plugins.list());
ipcMain.handle('plugins:setEnabled', (_e, id, enabled) => plugins.setEnabled(id, enabled));
ipcMain.handle('plugins:install', (_e, source) => plugins.install(source));
ipcMain.handle('plugins:uninstall', (_e, id) => plugins.uninstall(id));
ipcMain.handle('plugins:catalog', () => plugins.catalog());
ipcMain.handle('dialog:openPlugin', async () => {
  const r = await dialog.showOpenDialog(win, {
    title: 'Install Plugin from Disk',
    properties: ['openFile', 'openDirectory'],
    filters: [{ name: 'Plugin (.zip or folder with plugin.json)', extensions: ['zip', 'json'] }],
  });
  if (r.canceled) return null;
  const p = r.filePaths[0];
  return path.basename(p).toLowerCase() === 'plugin.json' ? path.dirname(p) : p;
});

const featureContext = {
  ipcMain,
  app,
  send,
  startProcess,
  killProcess,
  procs,
  getWindow: () => win,
  appDir: __dirname,
  vendorDir: path.join(__dirname, 'vendor'),
};

for (const file of plugins.mainModules()) {
  try {
    require(file).register(featureContext);
  } catch (err) {
    console.error(`plugin module ${file} failed to register:`, err);
  }
}

function createWindow() {
  win = new BrowserWindow({
    width: 1400,
    height: 900,
    backgroundColor: '#1e1f22',
    title: 'PyIDE',
    autoHideMenuBar: true,
    webPreferences: { preload: path.join(__dirname, 'preload.js'), contextIsolation: true, sandbox: false },
  });
  const folder = process.argv.slice(app.isPackaged ? 1 : 2).find((a) => !a.startsWith('-') && fs.existsSync(a));
  win.loadFile(path.join(__dirname, 'renderer', 'index.html'), { query: folder ? { open: path.resolve(folder) } : {} });
}

app.whenReady().then(createWindow);
app.on('window-all-closed', () => {
  for (const id of procs.keys()) killProcess(id);
  app.quit();
});
