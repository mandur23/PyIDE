// Updates, main side: electron-updater with a generic feed. The feed is the renderer's `updates.feedUrl` setting: an
// http(s) URL, or a local folder (or file: URL) holding latest.yml and the installers, which is served on 127.0.0.1
// while PyIDE runs. Only an NSIS install updates itself (download, then the silent installer on restart). An MSI install
// is pointed at the new .msi instead, since MSI installs are upgraded by Windows Installer. Source runs only check.
// NSIS downloads are differential when they can be: electron-updater rebuilds the new installer from the one this version
// was installed with, which the NSIS installer copies to %LOCALAPPDATA%\pyide-updater\installer.exe, and the blocks that
// changed. It reads the new installer's <url>.blockmap and the old one's (the same URL with the old version, unless
// %LOCALAPPDATA%\pyide-updater\current.blockmap is left from the last download) and fetches the changed blocks with Range
// requests. Anything that goes wrong (no cached installer, no old blockmap, no Range support, a hash mismatch of the
// rebuilt file) falls back to the full installer. The setting updates.differential and PYIDE_UPDATE_DIFFERENTIAL=0 turn
// it off.
const { shell } = require('electron');
const fs = require('fs');
const http = require('http');
const path = require('path');
const { pipeline } = require('stream');
const { fileURLToPath } = require('url');
const zlib = require('zlib');

function installKind(app) {
  // verify/update-delta.mjs downloads from a source run as an NSIS install would (it never installs).
  if (process.env.PYIDE_UPDATE_TEST === '1' && process.env.PYIDE_UPDATE_TEST_KIND) return process.env.PYIDE_UPDATE_TEST_KIND;
  if (!app.isPackaged) return 'source';
  return fs.existsSync(path.join(path.dirname(process.execPath), `Uninstall ${app.getName()}.exe`)) ? 'nsis' : 'msi';
}

// Serves the files of one folder, read-only, to this machine only. Single byte ranges are answered (206), which a
// differential download needs; a multi-range request gets the whole file, and electron-updater is told not to send one.
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
    const headers = { 'Content-Type': 'application/octet-stream', 'Cache-Control': 'no-store', 'Accept-Ranges': 'bytes' };
    const range = byteRange(req.headers.range, stat.size);
    if (range === 'unsatisfiable') { res.writeHead(416, { ...headers, 'Content-Range': `bytes */${stat.size}` }).end(); return; }
    const [start, end] = range || [0, stat.size - 1];
    if (range) headers['Content-Range'] = `bytes ${start}-${end}/${stat.size}`;
    res.writeHead(range ? 206 : 200, { ...headers, 'Content-Length': stat.size ? end - start + 1 : 0 });
    // pipeline, not pipe: a cancelled download closes the file, and a read error ends the response instead of
    // being thrown in the main process.
    if (req.method === 'HEAD' || !stat.size) res.end(); else pipeline(fs.createReadStream(file, { start, end }), res, () => {});
  });
  return new Promise((resolve, reject) => {
    server.once('error', reject);
    server.listen(0, '127.0.0.1', () => resolve({ server, url: `http://127.0.0.1:${server.address().port}/` }));
  });
}

// [start, end] (inclusive) for a single `bytes=` range, 'unsatisfiable', or null to send the whole file (no Range
// header, several ranges, or one that cannot be parsed, which HTTP allows a server to ignore).
function byteRange(header, size) {
  const m = /^bytes=(\d*)-(\d*)$/.exec(String(header || '').trim());
  if (!m || (m[1] === '' && m[2] === '')) return null;
  let start;
  let end;
  if (m[1] === '') { start = Math.max(0, size - Number(m[2])); end = size - 1; } // the last n bytes
  else { start = Number(m[1]); end = m[2] === '' ? size - 1 : Math.min(Number(m[2]), size - 1); }
  return start > end || start >= size ? 'unsatisfiable' : [start, end];
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
// seenVersion: the version that last ran with this user data. null when the file predates it (0.2.4 and older wrote
// no seenVersion), undefined when there is no file (a fresh install).
function readHistory(file) {
  const num = (v) => (Number.isFinite(v) && v > 0 ? v : null);
  try {
    const h = JSON.parse(fs.readFileSync(file, 'utf8'));
    return { lastCheck: num(h.lastCheck), lastAttempt: num(h.lastAttempt), failures: Math.max(0, Math.floor(Number(h.failures) || 0)),
      lastError: typeof h.lastError === 'string' ? h.lastError : null, seenVersion: typeof h.seenVersion === 'string' ? h.seenVersion : null };
  } catch { return { lastCheck: null, lastAttempt: null, failures: 0, lastError: null, seenVersion: undefined }; }
}

// CHANGELOG.md (shipped in the app) as [{version, text}], newest first: each "## <version>" heading and the lines under it.
function readChangelog(file) {
  let text = '';
  try { text = fs.readFileSync(file, 'utf8'); } catch { return []; }
  const sections = [];
  for (const line of text.split(/\r?\n/)) {
    const head = /^##\s+v?(\d+(?:\.\d+)*)\s*$/.exec(line);
    if (head) sections.push({ version: head[1], lines: [] });
    else if (/^#{1,2}\s/.test(line)) sections.push(null);
    else if (sections.at(-1)) sections.at(-1).lines.push(line);
  }
  return sections.filter(Boolean).map(({ version, lines }) => ({ version, text: lines.join('\n').trim() })).filter((s) => s.text);
}
const compareVersions = (a, b) => {
  const x = a.split('.').map(Number), y = b.split('.').map(Number);
  for (let i = 0; i < Math.max(x.length, y.length); i++) if ((x[i] || 0) !== (y[i] || 0)) return (x[i] || 0) - (y[i] || 0);
  return 0;
};

// The notes to show once after an update: the sections newer than the version that last ran, up to this one. After an
// update from a version that did not record itself, only this version's section; nothing on a fresh install.
function notesAfterUpdate(changelog, version, seenVersion) {
  if (seenVersion === undefined || (seenVersion && compareVersions(seenVersion, version) >= 0)) return [];
  return changelog.filter((s) => compareVersions(s.version, version) <= 0 && (seenVersion ? compareVersions(s.version, seenVersion) > 0 : compareVersions(s.version, version) === 0));
}

// A current.blockmap that electron-updater kept from an earlier download describes the installer of that download, which
// is not the cached installer.exe when that update was never installed. The rebuilt file would then fail its hash check
// and the whole installer would be downloaded, so a blockmap whose length differs from installer.exe is removed and
// the feed's blockmap of this version is used instead.
function dropStaleBlockmap(cacheDir, log) {
  if (!cacheDir) return;
  const file = path.join(cacheDir, 'current.blockmap');
  try {
    if (!fs.existsSync(file)) return;
    const map = JSON.parse(zlib.gunzipSync(fs.readFileSync(file)).toString());
    const entry = map.files?.[0];
    const length = (entry?.offset || 0) + (entry?.sizes || []).reduce((a, b) => a + b, 0);
    let installer = null;
    try { installer = fs.statSync(path.join(cacheDir, 'installer.exe')).size; } catch {}
    if (length === installer) return;
    fs.rmSync(file, { force: true });
    log.info(`removed ${file}: it describes a ${length}-byte installer, the cached installer.exe has ${installer ?? 'no file'}`);
  } catch (err) {
    try { fs.rmSync(file, { force: true }); } catch {}
    log.warn(`removed unreadable ${file}: ${err.message}`);
  }
}

const mb = (n) => (n == null ? '?' : n < 100 * 1024 ? `${(n / 1024).toFixed(1)} KB` : `${(n / 1048576).toFixed(1)} MB`);

exports.installKind = installKind;
exports.serveFolder = serveFolder;
exports.byteRange = byteRange;
exports.readChangelog = readChangelog;
exports.notesAfterUpdate = notesAfterUpdate;

exports.register = ({ ipcMain, app, send, diagnostics }) => {
  const log = diagnostics?.logger('#updater') || console;
  const kind = installKind(app);
  let updater = null;
  let feed = null; // {key, url, dir, server}
  const historyFile = path.join(app.getPath('userData'), 'updater.json');
  // PYIDE_UPDATE_INTERVAL_MS replaces the length of a day for the periodic check (verify/report-update.mjs).
  const intervalMs = Number(process.env.PYIDE_UPDATE_INTERVAL_MS) > 0 ? Number(process.env.PYIDE_UPDATE_INTERVAL_MS) : null;
  // phase: idle | checking | available | downloading | downloaded | error. checks: checks run this session.
  // download: how the current or last download goes, {mode: 'delta' | 'full', size (of the installer), bytes (to
  // download; for a delta, the changed blocks), reason (why full: 'off' or 'fallback')}.
  let state = { kind, version: app.getVersion(), defaultFeed: defaultFeed(app), phase: 'idle', intervalMs, checks: 0, download: null, ...readHistory(historyFile) };
  // PYIDE_CHANGELOG replaces the shipped CHANGELOG.md (verify/updater.mjs).
  const changelog = readChangelog(process.env.PYIDE_CHANGELOG || path.join(app.getAppPath(), 'CHANGELOG.md'));
  let afterUpdate = notesAfterUpdate(changelog, state.version, state.seenVersion);
  if (state.seenVersion !== state.version) { state.seenVersion = state.version; saveHistory(); }
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
    updater.on('download-progress', (p) => {
      // During a differential download the total is the size of the changed blocks.
      const download = state.download && (state.download.mode === 'delta' || state.download.bytes == null) ? { ...state.download, bytes: p.total } : state.download;
      setState({ phase: 'downloading', percent: Math.floor(p.percent), transferred: p.transferred, total: p.total, download });
    });
    updater.on('update-downloaded', (info) => setState({ phase: 'downloaded', available: info.version, percent: 100 }));
    updater.on('error', (err) => log.warn(`update error: ${err?.message || err}`));
    // electron-updater's NSIS download calls this unless disableDifferentialDownload is set, and downloads the full
    // installer when it returns true, which it does after logging any error. Wrapped to say which happened.
    const differential = updater.differentialDownloadInstaller;
    if (typeof differential === 'function') {
      updater.differentialDownloadInstaller = async function (fileInfo, ...rest) {
        const size = fileInfo?.info?.size ?? null;
        const version = rest[0]?.updateInfoAndProvider?.info?.version || state.available;
        dropStaleBlockmap(this.downloadedUpdateHelper?.cacheDir, log);
        setState({ download: { mode: 'delta', size, bytes: null, reason: null } });
        const full = await differential.call(this, fileInfo, ...rest);
        if (full) {
          log.warn(`differential download of ${version} not possible (see the error above); downloading the full installer (${mb(size)})`);
          setState({ download: { mode: 'full', size, bytes: size, reason: 'fallback' }, percent: 0 });
        } else log.info(`downloaded ${version} differentially: ${mb(state.download?.bytes)} of ${mb(size)}`);
        return full;
      };
    }
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
    // One Range request per changed run of blocks: the local server and GitHub's release downloads answer single ranges,
    // not multipart ones.
    getUpdater().setFeedURL({ provider: 'generic', url: feed.url, useMultipleRangeRequest: false });
    return feed;
  }

  function saveHistory() {
    const { lastCheck, lastAttempt, failures, lastError, seenVersion } = state;
    try { fs.writeFileSync(historyFile, JSON.stringify({ lastCheck, lastAttempt, failures, lastError, seenVersion }, null, 2)); } catch (err) { log.warn(`could not save ${historyFile}: ${err.message}`); }
  }

  ipcMain.handle('updater:state', () => state);
  // -> {version, afterUpdate: [{version, text}] (given to the first window that asks), all: the whole changelog}.
  ipcMain.handle('updater:releaseNotes', () => {
    const notes = { version: state.version, afterUpdate, all: changelog.filter((s) => compareVersions(s.version, state.version) <= 0) };
    afterUpdate = [];
    return notes;
  });

  // -> {available: version | null}; throws with a readable message when the feed cannot be read.
  ipcMain.handle('updater:check', async (_e, feedValue) => {
    if (state.phase === 'downloading' || state.phase === 'downloaded') return { available: state.available };
    setState({ phase: 'checking', error: null, checks: state.checks + 1, lastAttempt: Date.now() });
    try {
      await useFeed(feedValue);
      const u = getUpdater();
      // electron-updater only checks packaged apps; a source run still reports what the feed offers.
      if (!app.isPackaged) u.forceDevUpdateConfig = true;
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

  // Test hook for verify/report-update.mjs and verify/updater.mjs: a source run cannot download, so the test sets the
  // phase (or, given an object, any state fields) itself.
  if (process.env.PYIDE_UPDATE_TEST === '1') ipcMain.handle('updater:testPhase', (_e, phase) => { setState(phase && typeof phase === 'object' ? phase : { phase }); return state; });

  // options: {differential} (the setting updates.differential; PYIDE_UPDATE_DIFFERENTIAL=0 overrides it).
  ipcMain.handle('updater:download', async (_e, options) => {
    if (kind !== 'nsis') throw new Error('Only the PyIDE installer (.exe) updates itself');
    if (state.phase === 'downloaded') return true;
    const u = getUpdater();
    const off = process.env.PYIDE_UPDATE_DIFFERENTIAL === '0' ? 'PYIDE_UPDATE_DIFFERENTIAL=0' : options?.differential === false ? 'updates.differential' : null;
    u.disableDifferentialDownload = !!off;
    if (off) log.info(`differential download is off (${off}); downloading the full installer`);
    setState({ phase: 'downloading', percent: 0, download: off ? { mode: 'full', size: null, bytes: null, reason: 'off' } : null });
    try {
      await u.downloadUpdate();
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
