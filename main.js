const { app, BrowserWindow, ipcMain, dialog, shell, clipboard } = require('electron');
const path = require('path');
const fs = require('fs');
const { spawn, execFileSync } = require('child_process');
const { createPluginManager } = require('./main/plugin-manager');
const textCodec = require('./main/text-codec');
const iconv = require('iconv-lite');
const { createWindowManager } = require('./main/windows');

if (process.env.PYIDE_USER_DATA) app.setPath('userData', process.env.PYIDE_USER_DATA);

const IGNORED = new Set(['.git', '__pycache__', 'node_modules', '.idea', '.mypy_cache', '.pytest_cache', '.ruff_cache']);

let win;
const procs = new Map();
let nextProcId = 1;

const send = (channel, payload) => win && !win.isDestroyed() && win.webContents.send(channel, payload);
// Virtual environments are folders with a pyvenv.cfg; they are never part of the project's own sources.
const isVenv = (dir) => fs.existsSync(path.join(dir, 'pyvenv.cfg'));

// Spawns a child whose output streams to the renderer as proc:data / proc:exit, keyed by the returned id.
function startProcess(cmd, args, opts = {}) {
  const id = nextProcId++;
  const { encoding, ...spawnOpts } = opts;
  const proc = spawn(cmd, args, {
    ...spawnOpts,
    env: { ...process.env, PYTHONIOENCODING: 'utf-8', PYTHONUNBUFFERED: '1', ...opts.env },
  });
  procs.set(id, proc);
  // opts.encoding: output encoding of the child (e.g. 'cp949' for cmd.exe/Maven on Korean Windows); UTF-8 by default.
  // Streaming decoders keep multi-byte characters intact across chunk boundaries.
  const forward = (stream) => {
    const decoder = iconv.getDecoder(opts.encoding || 'utf8');
    return (d) => send('proc:data', { id, stream, text: decoder.write(d) });
  };
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

ipcMain.handle('fs:walk', (_e, root, excludedDirs = []) => {
  const out = [];
  const excluded = new Set(excludedDirs.map((d) => d.toLowerCase()));
  const walk = (dir) => {
    for (const d of fs.readdirSync(dir, { withFileTypes: true })) {
      if (out.length >= 20000) return;
      if (IGNORED.has(d.name) || ['.venv', 'venv', 'env'].includes(d.name)) continue;
      const p = path.join(dir, d.name);
      if (d.isDirectory() && (isVenv(p) || excluded.has(p.toLowerCase()))) continue;
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
// Encoding-aware text IO for editor documents (UTF-8, UTF-8 with BOM, UTF-16, CP949/EUC-KR).
ipcMain.handle('fs:readText', (_e, p) => textCodec.read(p));
ipcMain.handle('fs:writeText', (_e, p, text, encoding) => textCodec.write(p, text, encoding));
ipcMain.handle('fs:decode', (_e, p, encoding) => textCodec.read(p, encoding));
ipcMain.handle('shell:showInFolder', (_e, p) => shell.showItemInFolder(p));
ipcMain.handle('shell:openPath', (_e, p) => shell.openPath(p));
ipcMain.handle('clipboard:writeText', (_e, text) => clipboard.writeText(text));
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
    // Every venv in the project, up to two levels deep (.venv, .venv-rvc, ai/.venv...), nearest first.
    const venvs = [];
    const scan = (dir, depth) => {
      let entries = [];
      try { entries = fs.readdirSync(dir, { withFileTypes: true }); } catch { return; }
      for (const d of entries) {
        if (!d.isDirectory() || IGNORED.has(d.name)) continue;
        const p = path.join(dir, d.name);
        if (isVenv(p)) venvs.push(p);
        else if (depth < 2) scan(p, depth + 1);
      }
    };
    scan(root, 1);
    venvs.sort((a, b) => a.split(path.sep).length - b.split(path.sep).length || a.localeCompare(b));
    for (const v of venvs) {
      const exe = path.join(v, 'Scripts', 'python.exe');
      if (fs.existsSync(exe)) add(exe, [], path.relative(root, v));
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

// Detached editor windows load only the plugins that declare "detached": true.
ipcMain.handle('core:features', (e) => plugins.rendererEntries({ detached: e.sender.id !== win?.webContents.id }));
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

const windows = createWindowManager({ appDir: __dirname });

function createWindow() {
  const folder = process.argv.slice(app.isPackaged ? 1 : 2).find((a) => !a.startsWith('-') && fs.existsSync(a));
  win = windows.createMain(folder ? { open: path.resolve(folder) } : {});
}

app.whenReady().then(createWindow);
app.on('window-all-closed', () => {
  for (const id of procs.keys()) killProcess(id);
  app.quit();
});
