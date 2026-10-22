// Updates, main side: electron-updater with a generic feed. The feed is the renderer's `updates.feedUrl` setting: an
// http(s) URL, or a local folder (or file: URL) holding latest.yml and the installers, which is served on 127.0.0.1
// while PyIDE runs. Only an NSIS install updates itself (download, then the silent installer on restart). An MSI install
// is pointed at the new .msi instead, since MSI installs are upgraded by Windows Installer. Source runs only check.
const { shell } = require('electron');
const fs = require('fs');
const http = require('http');
const path = require('path');
const { pipeline } = require('stream');
const { fileURLToPath } = require('url');

function installKind(app) {
  if (!app.isPackaged) return 'source';
  return fs.existsSync(path.join(path.dirname(process.execPath), `Uninstall ${app.getName()}.exe`)) ? 'nsis' : 'msi';
}

// Serves the files of one folder, read-only, to this machine only.
function serveFolder(dir) {
  const root = path.resolve(dir);
  const server = http.createServer((req, res) => {
    let file = null;
    let stat = null;
    try { // a malformed escape (%E0) throws URIError: a 404, not an exception in the main process
      file = path.resolve(root, decodeURIComponent(new URL(req.url, 'http://localhost').pathname).replace(/^\/+/, ''));
      stat = file.startsWith(root + path.sep) && fs.statSync(file);
    } catch {}
    if (!stat || !stat.isFile()) { res.writeHead(404).end(); return; }
    res.writeHead(200, { 'Content-Length': stat.size, 'Content-Type': 'application/octet-stream', 'Cache-Control': 'no-store' });
    // pipeline, not pipe: a cancelled download closes the file, and a read error ends the response instead of
    // being thrown in the main process.
    if (req.method === 'HEAD') res.end(); else pipeline(fs.createReadStream(file), res, () => {});
  });
  return new Promise((resolve, reject) => {
    server.once('error', reject);
    server.listen(0, '127.0.0.1', () => resolve({ server, url: `http://127.0.0.1:${server.address().port}/` }));
  });
}

// The feed an installed copy uses until the user sets one: package.json `updateFeed` (GitHub Releases). Source runs have
// none. PYIDE_UPDATE_FEED overrides it, and 'off' turns it off (the verify suites do, so they never reach GitHub).
function defaultFeed(app) {
  const env = process.env.PYIDE_UPDATE_FEED;
  if (env != null) return env === 'off' ? '' : env;
  if (!app.isPackaged) return '';
  try { return String(require(path.join(app.getAppPath(), 'package.json')).updateFeed || ''); } catch { return ''; }
}

// {url, dir}: dir is set for a local folder feed.
function resolveFeed(feed) {
  const value = String(feed || '').trim();
  if (!value) throw new Error('No update feed is set');
  if (/^https?:\/\//i.test(value)) return { url: value.endsWith('/') ? value : `${value}/` };
  const dir = /^file:/i.test(value) ? fileURLToPath(value) : value;
  if (!path.isAbsolute(dir) || !fs.existsSync(path.join(dir, 'latest.yml'))) throw new Error(`No latest.yml in ${dir}`);
  return { dir: path.resolve(dir) };
}

// When checks ran, kept across restarts so the periodic check (renderer) can skip one that ran recently and back off
// after failures: {lastCheck, lastAttempt, failures, lastError}. lastCheck is the last check that read the feed.
function readHistory(file) {
  const num = (v) => (Number.isFinite(v) && v > 0 ? v : null);
  try {
    const h = JSON.parse(fs.readFileSync(file, 'utf8'));
    return { lastCheck: num(h.lastCheck), lastAttempt: num(h.lastAttempt), failures: Math.max(0, Math.floor(Number(h.failures) || 0)),
      lastError: typeof h.lastError === 'string' ? h.lastError : null };
  } catch { return { lastCheck: null, lastAttempt: null, failures: 0, lastError: null }; }
}

exports.installKind = installKind;

exports.register = ({ ipcMain, app, send, diagnostics }) => {
  const log = diagnostics?.logger('#updater') || console;
  const kind = installKind(app);
  let updater = null;
  let feed = null; // {key, url, dir, server}
  const historyFile = path.join(app.getPath('userData'), 'updater.json');
  // PYIDE_UPDATE_INTERVAL_MS replaces the length of a day for the periodic check (verify/report-update.mjs).
  const intervalMs = Number(process.env.PYIDE_UPDATE_INTERVAL_MS) > 0 ? Number(process.env.PYIDE_UPDATE_INTERVAL_MS) : null;
  // phase: idle | checking | available | downloading | downloaded | error. checks: checks run this session.
  let state = { kind, version: app.getVersion(), defaultFeed: defaultFeed(app), phase: 'idle', intervalMs, checks: 0, ...readHistory(historyFile) };
  const setState = (patch) => {
    state = { ...state, ...patch };
    send('updater:state', state);
  };

  function getUpdater() {
    if (updater) return updater;
    ({ autoUpdater: updater } = require('electron-updater'));
    updater.logger = log;
    updater.autoDownload = false;
    updater.autoInstallOnAppQuit = false;
    updater.disableDifferentialDownload = true;
    updater.on('download-progress', (p) => setState({ phase: 'downloading', percent: Math.floor(p.percent), transferred: p.transferred, total: p.total }));
    updater.on('update-downloaded', (info) => setState({ phase: 'downloaded', available: info.version, percent: 100 }));
    updater.on('error', (err) => log.warn(`update error: ${err?.message || err}`));
    return updater;
  }

  async function useFeed(value) {
    const key = String(value || '').trim();
    if (feed?.key === key) return feed;
    feed?.server?.close();
    feed = null;
    const resolved = resolveFeed(key);
    if (resolved.dir) {
      const { server, url } = await serveFolder(resolved.dir);
      feed = { key, url, dir: resolved.dir, server };
    } else feed = { key, ...resolved };
    getUpdater().setFeedURL({ provider: 'generic', url: feed.url });
    return feed;
  }

  function saveHistory() {
    const { lastCheck, lastAttempt, failures, lastError } = state;
    try { fs.writeFileSync(historyFile, JSON.stringify({ lastCheck, lastAttempt, failures, lastError }, null, 2)); } catch (err) { log.warn(`could not save ${historyFile}: ${err.message}`); }
  }

  ipcMain.handle('updater:state', () => state);

  // -> {available: version | null}; throws with a readable message when the feed cannot be read.
  ipcMain.handle('updater:check', async (_e, feedValue) => {
    if (state.phase === 'downloading' || state.phase === 'downloaded') return { available: state.available };
    setState({ phase: 'checking', error: null, checks: state.checks + 1, lastAttempt: Date.now() });
    try {
      await useFeed(feedValue);
      const u = getUpdater();
      // electron-updater only checks packaged apps; a source run still reports what the feed offers.
      if (kind === 'source') u.forceDevUpdateConfig = true;
      const result = await u.checkForUpdates();
      const latest = result?.updateInfo?.version;
      const available = result?.isUpdateAvailable && latest ? latest : null;
      setState({ phase: available ? 'available' : 'idle', available, notes: result?.updateInfo?.releaseNotes || null, lastCheck: Date.now(), failures: 0, lastError: null });
      saveHistory();
      return { available };
    } catch (err) {
      setState({ phase: 'error', error: err.message, failures: state.failures + 1, lastError: err.message });
      saveHistory();
      throw err;
    }
  });

  // Test hook for verify/report-update.mjs: a source run cannot download, so the test sets the phase itself.
  if (process.env.PYIDE_UPDATE_TEST === '1') ipcMain.handle('updater:testPhase', (_e, phase) => { setState({ phase }); return state; });

  ipcMain.handle('updater:download', async () => {
    if (kind !== 'nsis') throw new Error('Only the PyIDE installer (.exe) updates itself');
    if (state.phase === 'downloaded') return true;
    setState({ phase: 'downloading', percent: 0 });
    try {
      await getUpdater().downloadUpdate();
      return true;
    } catch (err) {
      setState({ phase: 'error', error: err.message });
      throw err;
    }
  });

  // Starts the downloaded installer silently (it restarts PyIDE) and quits. The installer closes PyIDE even if a window
  // refuses to close, so the renderer saves unsaved files first.
  ipcMain.handle('updater:install', () => {
    if (state.phase !== 'downloaded') return false;
    setImmediate(() => getUpdater().quitAndInstall(true, true));
    return true;
  });

  // MSI installs: show the new .msi in the feed folder, or open its download link.
  ipcMain.handle('updater:openInstaller', async () => {
    if (!feed || !state.available) return false;
    const name = `${app.getName()}-${state.available}.msi`;
    if (feed.dir) {
      const file = path.join(feed.dir, name);
      if (fs.existsSync(file)) shell.showItemInFolder(file);
      else await shell.openPath(feed.dir);
      return true;
    }
    await shell.openExternal(new URL(name, feed.url).href);
    return true;
  });

  app.on('before-quit', () => feed?.server?.close());
};
