const { app, BrowserWindow, ipcMain, dialog, shell, clipboard, protocol } = require('electron');
// The HTML preview serves project files over pyide-preview:// (main/features/viewers.js). A scheme gets standard URL
// resolution (relative stylesheets, scripts, images) only when it is declared before the app is ready.
protocol.registerSchemesAsPrivileged([{ scheme: 'pyide-preview', privileges: { standard: true, secure: true, supportFetchAPI: true, corsEnabled: true, stream: true } }]);
if (process.env.PYIDE_USER_DATA) app.setPath('userData', process.env.PYIDE_USER_DATA);
// First: the IDE log and internal error collection (no raw Electron error dialogs from here on).
const diagnostics = require('./main/diagnostics').install();
const path = require('path');
const fs = require('fs');
const { spawn, spawnSync } = require('child_process');
const { createPluginManager } = require('./main/plugin-manager');
const textCodec = require('./main/text-codec');
const iconv = require('iconv-lite');
const { createWindowManager } = require('./main/windows');
// Folder listings, project walks and interpreter probes run on a worker thread (see main/fs-scan.js).
const { scan: fsScan } = require('./main/fs-scan');

let win;
const procs = new Map();
let nextProcId = 1;

const send = (channel, payload) => win && !win.isDestroyed() && win.webContents.send(channel, payload);

// Spawns a child whose output streams to the renderer as proc:data / proc:exit, keyed by the returned id.
// The log records the launch and exit code; the output itself is the user's and stays out of it.
const procLog = diagnostics.logger('#process');
function startProcess(cmd, args, opts = {}) {
  const id = nextProcId++;
  const { encoding, filter, ...spawnOpts } = opts;
  const proc = spawn(cmd, args, {
    ...spawnOpts,
    env: { ...process.env, PYTHONIOENCODING: 'utf-8', PYTHONUNBUFFERED: '1', ...opts.env },
  });
  procs.set(id, proc);
  procLog.info(`#${id} started (pid ${proc.pid}): ${cmd} ${args.join(' ')}${opts.cwd ? ` in ${opts.cwd}` : ''}`);
  // opts.encoding: output encoding of the child (e.g. 'cp949' for cmd.exe/Maven on Korean Windows); UTF-8 by default.
  // Streaming decoders keep multi-byte characters intact across chunk boundaries.
  // opts.filter(text, stream) -> text: lets a launcher take its own marker lines out of the output (remote targets).
  const forward = (stream) => {
    const decoder = iconv.getDecoder(opts.encoding || 'utf8');
    return (d) => {
      const text = filter ? filter(decoder.write(d), stream) : decoder.write(d);
      if (text) send('proc:data', { id, stream, text });
    };
  };
  proc.stdout.on('data', forward('out'));
  proc.stderr.on('data', forward('err'));
  proc.on('error', (err) => { procLog.warn(`#${id} ${err.message}`); send('proc:data', { id, stream: 'err', text: `${err.message}\n` }); });
  // Input typed after the program closed its stdin or exited (EPIPE, write after end) has nowhere to go.
  proc.stdin?.on('error', (err) => procLog.info(`#${id} stdin: ${err.code || err.message}`));
  proc.on('close', (code) => {
    procLog.info(`#${id} exited with code ${code}`);
    procs.delete(id);
    send('proc:exit', { id, code });
  });
  return id;
}

// sync: wait for taskkill. At quit it must finish before the IDE exits, since Windows ends the IDE's own child
// processes with it (taskkill included) but not their children, such as the programs a cmd.exe or a script started.
function killProcess(id, { sync = false } = {}) {
  const proc = procs.get(id);
  if (!proc?.pid) return;
  proc.remoteKill?.(); // a program in a remote interpreter target outlives its local client (wsl.exe, ssh, docker)
  const args = ['/pid', String(proc.pid), '/T', '/F'];
  if (sync) spawnSync('taskkill', args, { windowsHide: true, timeout: 5000 });
  else spawn('taskkill', args, { windowsHide: true });
}

// Probe results by command, kept in userData/interpreters.json while the interpreter's python.exe and, for a venv,
// its base interpreter are unchanged on disk (mtime and size): the list is rebuilt on every launch, project open and settings change, and starting each
// Python took 100 ms, on the startup path. A venv that was deleted is no longer scanned, a recreated one has a new
// python.exe. `py` and `python` can start to mean another interpreter, or appear, without a cached file changing
// (a Python installed later), so a cached bare command, found or missing, is probed again in the background and
// the next list has the new answer.
const PROBES_FILE = path.join(app.getPath('userData'), 'interpreters.json');
const PROBES_VERSION = 2;
let probes = null; // Promise<Map<`${cmd} ${args}`, {version, executable, base, mtime, size, baseStat} | {missing: true}>>
const loadProbes = () => (probes ??= fs.promises.readFile(PROBES_FILE, 'utf8').then((text) => {
  const saved = JSON.parse(text);
  return saved.version === PROBES_VERSION ? new Map(Object.entries(saved.probes)) : new Map();
}).catch(() => new Map()));
let saving = Promise.resolve();
const saveProbes = (cache) => {
  saving = saving.then(async () => {
    await fs.promises.mkdir(path.dirname(PROBES_FILE), { recursive: true });
    await fs.promises.writeFile(`${PROBES_FILE}.tmp`, JSON.stringify({ version: PROBES_VERSION, probes: Object.fromEntries(cache) }));
    await fs.promises.rename(`${PROBES_FILE}.tmp`, PROBES_FILE);
  }).catch(() => {});
};
const statOf = (p) => fs.promises.stat(p).then((st) => ({ mtime: st.mtimeMs, size: st.size }), () => null);
const sameFile = (hit, st) => !!hit && !!st && st.mtime === hit.mtime && st.size === hit.size;
const reprobed = new Set(); // bare commands checked in the background this session
let probesStarted = 0;

async function probe(cache, key, cmd, args) {
  const info = await fsScan('probe', cmd, args);
  const entry = info ? { ...info, ...(await statOf(info.executable)), baseStat: await statOf(info.base) } : path.isAbsolute(cmd) ? null : { missing: true };
  const old = cache.get(key);
  const same = !!entry && !!old && (entry.missing ? !!old.missing : old.executable === entry.executable && sameFile(old, entry) && sameFile(old.baseStat, entry.baseStat));
  if (!same && (entry || old)) {
    if (entry) cache.set(key, entry); else cache.delete(key);
    saveProbes(cache);
  }
  return info;
}
async function probeInterpreter(cmd, args) {
  const cache = await loadProbes();
  const key = [cmd, ...args].join(' ').toLowerCase();
  const hit = cache.get(key);
  const bare = !path.isAbsolute(cmd);
  const valid = !!hit && (hit.missing ? bare : sameFile(hit, await statOf(hit.executable)) && sameFile(hit.baseStat, await statOf(hit.base)));
  if (!valid) {
    probesStarted++;
    return probe(cache, key, cmd, args);
  }
  if (bare && !reprobed.has(key)) { reprobed.add(key); probe(cache, key, cmd, args).catch(() => {}); }
  return hit.missing ? null : hit;
}

ipcMain.handle('dialog:openFolder', async () => {
  const r = await dialog.showOpenDialog(win, { properties: ['openDirectory'] });
  return r.canceled ? null : r.filePaths[0];
});
ipcMain.handle('dialog:openFile', async (_e, filters) => {
  const r = await dialog.showOpenDialog(win, { properties: ['openFile'], filters });
  return r.canceled ? null : r.filePaths[0];
});

ipcMain.handle('fs:list', (_e, dir) => fsScan('list', dir));
ipcMain.handle('fs:walk', (_e, root, excludedDirs = []) => fsScan('walk', root, excludedDirs));

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
ipcMain.handle('clipboard:readText', () => clipboard.readText());
// Only web pages leave the app; anything else (file:, custom schemes) is refused.
ipcMain.handle('shell:openExternal', (_e, url) => (/^https?:\/\//i.test(url) ? shell.openExternal(url) : false));
ipcMain.handle('fs:trash', (_e, p) => shell.trashItem(p));

// The project's venvs (nearest first), the configured extra interpreters, then the py launcher and python from PATH;
// all probed at once, and an executable found twice keeps its first entry.
const interpLog = diagnostics.logger('#interpreters');
ipcMain.handle('py:interpreters', async (_e, root, extraPaths = []) => {
  const t0 = performance.now();
  const started = probesStarted;
  const candidates = [];
  if (root) {
    for (const v of await fsScan('venvs', root)) {
      const exe = path.join(v, 'Scripts', 'python.exe');
      if (fs.existsSync(exe)) candidates.push([exe, [], path.relative(root, v)]);
    }
  }
  for (const p of extraPaths) if (fs.existsSync(p)) candidates.push([p, [], path.basename(path.dirname(path.dirname(p))) || p]);
  candidates.push(['py', ['-3'], 'py launcher'], ['python', [], 'python']);
  const infos = await Promise.all(candidates.map(([cmd, args]) => probeInterpreter(cmd, args)));
  const found = [];
  const seen = new Set();
  candidates.forEach(([cmd, args, label], i) => {
    const info = infos[i];
    if (!info || seen.has(info.executable.toLowerCase())) return;
    seen.add(info.executable.toLowerCase());
    found.push({ cmd, args, label: `${label} (Python ${info.version})`, executable: info.executable, version: info.version });
  });
  interpLog.info(`${found.length} of ${candidates.length} candidates in ${Math.round(performance.now() - t0)} ms, ${probesStarted - started} probed`);
  return found;
});

ipcMain.handle('proc:input', (_e, id, text) => procs.get(id)?.stdin.write(text));
// stdin.end() returns the stream, which cannot cross IPC; the handler answers nothing.
ipcMain.handle('proc:closeInput', (_e, id) => { procs.get(id)?.stdin.end(); });
ipcMain.handle('proc:kill', (_e, id) => killProcess(id));

const plugins = createPluginManager({ appDir: __dirname, userDataDir: app.getPath('userData') });
diagnostics.setPluginResolver(plugins.ownerOf);

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
ipcMain.handle('core:features', async (e) => {
  await featuresRegistered;
  return plugins.rendererEntries({ detached: e.sender.id !== win?.webContents.id });
});
ipcMain.on('core:localeSync', (e, lang) => { e.returnValue = plugins.localeDictionary(lang); });
// A normal quit, not app.exit(): windows with unsaved files still ask, and the plugins' before-quit/will-quit handlers
// (index and history flushes, terminals, servers, lock files) run before the new instance starts.
ipcMain.handle('core:relaunch', () => {
  app.relaunch();
  app.quit();
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

// Packaged builds load the app from resources/app.asar, which only Electron can read. Files that other programs open
// (Python scripts, ruff.exe, pyright run as Node) are unpacked next to it (package.json build.asarUnpack).
const unpackedDir = __dirname.replace(/\.asar$/, '.asar.unpacked');

const featureContext = {
  ipcMain,
  app,
  send,
  startProcess,
  killProcess,
  procs,
  getWindow: () => win,
  appDir: __dirname,
  unpackedDir,
  vendorDir: path.join(unpackedDir, 'vendor'),
  diagnostics,
};

// Feature modules register one per event-loop turn, so the window's first synchronous IPC calls (settings, locale)
// are answered in between. core:features answers only after the last one, and the plugin scripts it lists are the
// only callers of feature channels.
let featuresRegistered = null;
function registerFeatures() {
  const files = [require.resolve('./main/new-project'), ...plugins.mainModules()];
  featuresRegistered = new Promise((resolve) => {
    const next = (i) => {
      if (i === files.length) return resolve();
      try {
        require(files[i]).register(featureContext);
      } catch (err) {
        diagnostics.report({ source: 'plugin', kind: 'load', error: err, title: `Plugin module ${path.basename(files[i])} failed to load`, files: [files[i]] });
      }
      setImmediate(next, i + 1);
    };
    next(0);
  });
}

const windows = createWindowManager({ appDir: __dirname });

// A folder argument opens it as the project; a file ("Open with PyIDE" on a .py) opens its folder and then the file.
function createWindow() {
  const arg = process.argv.slice(app.isPackaged ? 1 : 2).find((a) => !a.startsWith('-') && fs.existsSync(a));
  const target = arg && path.resolve(arg);
  const query = !target ? {} : fs.statSync(target).isDirectory() ? { open: target } : { open: path.dirname(target), file: target };
  win = windows.createMain(query);
}

// The window starts loading before the feature modules are required, so the renderer process starts while they
// load. Core renderer code only uses channels registered above; see registerFeatures for the feature channels.
app.whenReady().then(() => {
  createWindow();
  registerFeatures();
});
app.on('window-all-closed', () => app.quit());
// will-quit, not window-all-closed: app.quit() (a relaunch, a plugin's deferred quit) closes the windows without
// emitting window-all-closed, and the programs started here must not outlive the IDE either way.
app.on('will-quit', () => {
  for (const id of procs.keys()) killProcess(id, { sync: true });
});
