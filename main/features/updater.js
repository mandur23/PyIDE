// Updates, main side: electron-updater with a generic feed. The feed is the renderer's `updates.feedUrl` setting: an
// https URL, http on this computer, or a local folder (or file: URL) holding latest.yml and the installers, which is
// served on 127.0.0.1 while Nano Studio runs. The channel (`updates.channel`) picks the feed file: latest.yml for Stable, beta.yml for Beta. Only an NSIS install updates itself (download, then the silent installer on restart). An MSI install
// is pointed at the new .msi instead, since MSI installs are upgraded by Windows Installer. Source runs only check.
// NSIS downloads are differential when they can be: electron-updater rebuilds the new installer from the one this version
// was installed with, which the NSIS installer copies to %LOCALAPPDATA%\nano-studio-updater\installer.exe, and the blocks that
// changed. It reads the new installer's <url>.blockmap and the old one's (the same URL with the old version, unless
// %LOCALAPPDATA%\nano-studio-updater\current.blockmap is left from the last download) and fetches the changed blocks with Range
// requests. Anything that goes wrong (no cached installer, no old blockmap, no Range support, a hash mismatch of the
// rebuilt file) falls back to the full installer. The setting updates.differential and PYIDE_UPDATE_DIFFERENTIAL=0 turn
// it off.
// Installers are not Authenticode-signed, so electron-updater only checks the sha512 in latest.yml, which comes from the
// same release as the installer. The update is therefore checked here against <installer>.sig and main/release-key.js
// before the phase can become 'downloaded', the only way to updater:install. A missing or bad signature refuses the
// update. The default feed, https feeds and network shares need one; a folder on this computer or http on this computer
// (test builds, nobody signs them) does not, and the Update Ready dialog says that this update was not checked.
const { net, shell } = require('electron');
const fs = require('fs');
const http = require('http');
const path = require('path');
const { pipeline } = require('stream');
const { fileURLToPath } = require('url');
const zlib = require('zlib');
const { loopback } = require('../marketplace');
const release = require('../release-key');

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

// {url, signed} or {dir, signed}: dir is set for a local folder feed; signed means its installers need a signature. A
// network share can be replaced by anyone on the network, as plain http can.
function resolveFeed(feed) {
  const value = String(feed || '').trim();
  if (!value) throw new Error('No update feed is set');
  if (/^https?:\/\//i.test(value)) {
    let u;
    try { u = new URL(value); } catch { throw new Error(`Not a valid URL: ${value}`); }
    if (u.protocol === 'http:' && !loopback(u)) throw Object.assign(new Error(`INSECURE_FEED: ${value} must use https (http works only on this computer)`), { code: 'ERR_UPDATER_INSECURE_FEED' });
    return { url: value.endsWith('/') ? value : `${value}/`, signed: u.protocol === 'https:' };
  }
  const dir = /^file:/i.test(value) ? fileURLToPath(value) : value;
  if (!path.isAbsolute(dir) || !fs.existsSync(path.join(dir, 'latest.yml'))) throw new Error(`No latest.yml in ${dir}`);
  const resolved = path.resolve(dir);
  return { dir: resolved, signed: resolved.startsWith('\\\\') };
}

// The installer's file name in an update's channel file, which electron-updater downloads as <feed>/<name>. A channel
// file that names something else fails closed: no .sig there, or one that does not match the bytes downloaded.
const installerName = (info) => path.basename(new URL(info?.files?.find((f) => /\.exe$/i.test(f.url))?.url || info?.path, 'http://feed/').pathname);

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

// CHANGELOG.md (shipped in the app) as [{version, text}], newest first: each "## <version>" heading (0.2.5, or a beta
// such as 0.2.5-beta.1) and the lines under it.
function readChangelog(file) {
  let text = '';
  try { text = fs.readFileSync(file, 'utf8'); } catch { return []; }
  const sections = [];
  for (const line of text.split(/\r?\n/)) {
    const head = /^##\s+v?(\d+(?:\.\d+)*(?:-[0-9A-Za-z.-]+)?)\s*$/.exec(line);
    if (head) sections.push({ version: head[1], lines: [] });
    else if (/^#{1,2}\s/.test(line)) sections.push(null);
    else if (sections.at(-1)) sections.at(-1).lines.push(line);
  }
  return sections.filter(Boolean).map(({ version, lines }) => ({ version, text: lines.join('\n').trim() })).filter((s) => s.text);
}

// Semantic version precedence, which electron-updater also uses: 0.2.5-beta.1 < 0.2.5-beta.2 < 0.2.5-beta.10 < 0.2.5
// < 0.2.6. Build metadata (+…) is ignored. scripts/release.mjs uses this too.
function compareVersions(a, b) {
  const split = (v) => {
    const [core, pre] = String(v).split('+')[0].split(/-(.*)/s);
    return { core: core.split('.').map(Number), pre: pre ? pre.split('.') : [] };
  };
  const x = split(a), y = split(b);
  for (let i = 0; i < Math.max(x.core.length, y.core.length); i++) if ((x.core[i] || 0) !== (y.core[i] || 0)) return (x.core[i] || 0) - (y.core[i] || 0);
  if (!x.pre.length || !y.pre.length) return y.pre.length - x.pre.length; // a release ranks above its prereleases
  for (let i = 0; i < Math.max(x.pre.length, y.pre.length); i++) {
    const p = x.pre[i], q = y.pre[i];
    if (p === q) continue;
    if (p === undefined || q === undefined) return p === undefined ? -1 : 1;
    const pn = /^\d+$/.test(p), qn = /^\d+$/.test(q);
    if (pn && qn) return Number(p) - Number(q);
    if (pn !== qn) return pn ? -1 : 1;
    return p < q ? -1 : 1;
  }
  return 0;
}
const isPrerelease = (v) => /^[^+]*-/.test(v);
const coreVersion = (v) => v.split(/[-+]/)[0];

// The sections a build of `version` lists: those up to it. A stable build leaves out beta sections (its own section
// covers them). A beta also lists the section of the release it previews, so "## 0.2.5" shows in 0.2.5-beta.1.
function sectionsUpTo(changelog, version) {
  const beta = isPrerelease(version);
  return changelog.filter((s) => (beta || !isPrerelease(s.version))
    && (compareVersions(s.version, version) <= 0 || (beta && s.version === coreVersion(version))));
}

// The notes to show once after an update: the sections newer than the version that last ran, up to this one. After an
// update from a version that did not record itself, only this version's section; nothing on a fresh install.
function notesAfterUpdate(changelog, version, seenVersion) {
  if (seenVersion === undefined || (seenVersion && compareVersions(seenVersion, version) >= 0)) return [];
  return sectionsUpTo(changelog, version).filter((s) => (seenVersion ? compareVersions(s.version, seenVersion) > 0 : s.version === version || s.version === coreVersion(version)));
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

// electron-updater's own 60 s timeout never fires with Electron's net requests (it arms on a 'socket' event they do not
// emit), so a server that accepts the connection and never answers (a captive portal, a broken proxy) would keep a
// check going forever. PYIDE_UPDATE_TIMEOUT_MS shortens the deadline for verify/env-failures.mjs.
const CHECK_TIMEOUT_MS = Number(process.env.PYIDE_UPDATE_TIMEOUT_MS) > 0 ? Number(process.env.PYIDE_UPDATE_TIMEOUT_MS) : 30000;

const mb = (n) => (n == null ? '?' : n < 100 * 1024 ? `${(n / 1024).toFixed(1)} KB` : `${(n / 1048576).toFixed(1)} MB`);

exports.installKind = installKind;
exports.serveFolder = serveFolder;
exports.resolveFeed = resolveFeed;
exports.byteRange = byteRange;
exports.readChangelog = readChangelog;
exports.compareVersions = compareVersions;
exports.sectionsUpTo = sectionsUpTo;
exports.notesAfterUpdate = notesAfterUpdate;

// Once: the start chooser registers this module before the feature modules do. -> {state, checkAtStart, updateNow}.
let registered = null;
exports.register = (context) => (registered ||= start(context));

function start({ ipcMain, app, send, diagnostics }) {
  const log = diagnostics?.logger('#updater') || console;
  const kind = installKind(app);
  let updater = null;
  let feed = null; // {key, url, dir, server, signed}
  let offered = null; // what the last check found: {info, url (of the feed), signed}
  const historyFile = path.join(app.getPath('userData'), 'updater.json');
  // PYIDE_UPDATE_INTERVAL_MS replaces the length of a day for the periodic check (verify/report-update.mjs).
  const intervalMs = Number(process.env.PYIDE_UPDATE_INTERVAL_MS) > 0 ? Number(process.env.PYIDE_UPDATE_INTERVAL_MS) : null;
  // phase: idle | checking | available | downloading | downloaded | error. checks: checks run this session.
  // download: how the current or last download goes, {mode: 'delta' | 'full', size (of the installer), bytes (to
  // download; for a delta, the changed blocks), reason (why full: 'off' or 'fallback')}.
  // signature: of the downloaded update, 'verified', or 'unchecked' from a feed that needs none.
  let state ={ kind, version: app.getVersion(), defaultFeed: defaultFeed(app), phase: 'idle', intervalMs, checks: 0, download: null, ...readHistory(historyFile) };
  // PYIDE_CHANGELOG replaces the shipped CHANGELOG.md (verify/updater.mjs).
  const changelog = readChangelog(process.env.PYIDE_CHANGELOG || path.join(app.getAppPath(), 'CHANGELOG.md'));
  let afterUpdate = notesAfterUpdate(changelog, state.version, state.seenVersion);
  const setState = (patch) => {
    state = { ...state, ...patch };
    send('updater:state', state);
  };

  function getUpdater() {
    if (updater) return updater;
    ({ autoUpdater: updater } = require('electron-updater'));
    // A source run downloads only with a config file, which verify/app-mode.mjs keeps out of the repository.
    if (process.env.PYIDE_UPDATE_TEST === '1' && process.env.PYIDE_UPDATE_CONFIG) updater.updateConfigPath = process.env.PYIDE_UPDATE_CONFIG;
    updater.logger = log;
    updater.autoDownload = false;
    updater.autoInstallOnAppQuit = false;
    // A web installer runs a second, unsigned package named by the channel file.
    updater.disableWebInstaller = true;
    updater.on('download-progress', (p) => {
      // During a differential download the total is the size of the changed blocks.
      const download = state.download && (state.download.mode === 'delta' || state.download.bytes == null) ? { ...state.download, bytes: p.total } : state.download;
      setState({ phase: 'downloading', percent: Math.floor(p.percent), transferred: p.transferred, total: p.total, download });
    });
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
    const signed = resolved.signed || key === state.defaultFeed.trim();
    if (resolved.dir) {
      const { server, url } = await serveFolder(resolved.dir);
      feed = { key, url, dir: resolved.dir, server, signed };
    } else feed = { key, url: resolved.url, signed };
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
    const notes = { version: state.version, afterUpdate, all: sectionsUpTo(changelog, state.version) };
    afterUpdate = [];
    // Here and not at the start: a start chooser closed without picking an app has shown no notes.
    if (state.seenVersion !== state.version) { state.seenVersion = state.version; saveHistory(); }
    return notes;
  });

  // A check that outlives the deadline is abandoned: its request cannot be cancelled, but electron-updater is made to
  // forget it, or every later check would wait on the same request.
  function withDeadline(u, check) {
    let timer;
    const deadline = new Promise((_, reject) => {
      timer = setTimeout(() => {
        u.checkForUpdatesPromise = null;
        reject(Object.assign(new Error(`ETIMEDOUT: the update server did not answer within ${Math.round(CHECK_TIMEOUT_MS / 1000)} s`), { code: 'ETIMEDOUT' }));
      }, CHECK_TIMEOUT_MS);
    });
    return Promise.race([check, deadline]).finally(() => clearTimeout(timer));
  }

  // The update channel's file: latest.yml (Stable) or beta.yml (Beta), which every release keeps at the newest beta or
  // stable version, so a beta install also gets stable releases. A feed without beta.yml (a folder with only latest.yml)
  // is read as Stable. Setting a channel turns electron-updater's allowDowngrade on; it is turned off again, so a copy
  // switched from Beta back to Stable keeps its beta until a newer stable release comes out.
  async function checkChannel(u, channel) {
    u.channel = channel;
    u.allowDowngrade = false;
    try {
      return await u.checkForUpdates();
    } catch (err) {
      if (channel === 'latest' || err?.code !== 'ERR_UPDATER_CHANNEL_FILE_NOT_FOUND') throw err;
      log.info(`the feed has no ${channel}.yml; checking latest.yml`);
      return checkChannel(u, 'latest');
    }
  }

  // options: {channel: 'stable' | 'beta'} (the setting updates.channel).
  // -> {available: version | null}; throws with a readable message when the feed cannot be read.
  async function check(feedValue, options) {
    if (state.phase === 'downloading' || state.phase === 'downloaded') return { available: state.available };
    setState({ phase: 'checking', error: null, checks: state.checks + 1, lastAttempt: Date.now() });
    offered = null;
    try {
      const { url, signed } = await useFeed(feedValue);
      const u = getUpdater();
      // electron-updater only checks packaged apps; a source run still reports what the feed offers.
      if (!app.isPackaged) u.forceDevUpdateConfig = true;
      const result = await withDeadline(u, checkChannel(u, options?.channel === 'beta' ? 'beta' : 'latest'));
      const latest = result?.updateInfo?.version;
      const available = result?.isUpdateAvailable && latest ? latest : null;
      if (available) offered = { info: result.updateInfo, url, signed };
      setState({ phase: available ? 'available' : 'idle', available, notes: result?.updateInfo?.releaseNotes || null, lastCheck: Date.now(), failures: 0, lastError: null });
      saveHistory();
      return { available };
    } catch (err) {
      setState({ phase: 'error', error: err.message, failures: state.failures + 1, lastError: err.message });
      saveHistory();
      // Offline, a feed that is not there or not an update feed: the renderer tells the user; not an IDE error.
      if (diagnostics?.isEnvironmentError(err) || /^(HTTP_ERROR_|ERR_UPDATER_)/.test(err?.code)) diagnostics?.markExpected(err);
      throw err;
    }
  }
  ipcMain.handle('updater:check', (_e, feedValue, options) => check(feedValue, options));

  // Test hook for verify/report-update.mjs and verify/updater.mjs: a source run cannot download, so the test sets the
  // phase (or, given an object, any state fields) itself.
  if (process.env.PYIDE_UPDATE_TEST === '1') ipcMain.handle('updater:testPhase', (_e, phase) => { setState(phase && typeof phase === 'object' ? phase : { phase }); return state; });

  // The renderer shows its own text for this prefix; the reason goes to the log.
  function refused(why) {
    log.warn(`update refused: ${why}`);
    return Object.assign(new Error(`UPDATE_SIGNATURE: ${why}`), { code: 'ERR_UPDATER_INVALID_SIGNATURE' });
  }

  // Read before the download: a release without a signature costs no installer download. Electron's net, as the
  // download uses, so a proxy that lets the installer through also lets this through.
  async function readSignature() {
    if (!offered) throw refused('no checked update to download');
    const url = new URL(`${installerName(offered.info)}.sig`, offered.url).href;
    try {
      const res = await net.fetch(url, { cache: 'no-store', signal: AbortSignal.timeout(CHECK_TIMEOUT_MS) });
      if (res.ok) return await res.text();
      throw new Error(`HTTP ${res.status}`);
    } catch (err) {
      throw refused(`${url} could not be read (${err.message})`);
    }
  }

  // After the download, not in electron-updater's verifySignature hook: that hook runs only when package.json names a
  // publisherName, and never for an installer already in its cache from an earlier run. installerPath is the final file
  // on both paths. A refused file leaves the cache, so nothing stays that a later run would find.
  async function checkInstaller(u, signature) {
    let ok = false;
    try { ok = await release.verify(await fs.promises.readFile(u.installerPath), signature); } catch (err) { log.warn(`could not read the installer: ${err.message}`); }
    if (ok) { log.info(`${path.basename(u.installerPath)} matches its signature`); return; }
    await u.downloadedUpdateHelper?.clear();
    throw refused(`the installer does not match ${installerName(offered.info)}.sig`);
  }

  // options: {differential} (the setting updates.differential; PYIDE_UPDATE_DIFFERENTIAL=0 overrides it).
  async function download(options) {
    if (kind !== 'nsis') throw new Error('Only the Nano Studio installer (.exe) updates itself');
    if (state.phase === 'downloaded') return true;
    const u = getUpdater();
    const off = process.env.PYIDE_UPDATE_DIFFERENTIAL === '0' ? 'PYIDE_UPDATE_DIFFERENTIAL=0' : options?.differential === false ? 'updates.differential' : null;
    u.disableDifferentialDownload = !!off;
    if (off) log.info(`differential download is off (${off}); downloading the full installer`);
    setState({ phase: 'downloading', percent: 0, signature: null, download: off ? { mode: 'full', size: null, bytes: null, reason: 'off' } : null });
    try {
      const unchecked = offered?.signed === false;
      const signature = unchecked ? null : await readSignature();
      await u.downloadUpdate();
      if (unchecked) log.warn(`the installer from ${offered.url} was not checked: this feed needs no signature`);
      else await checkInstaller(u, signature);
      setState({ phase: 'downloaded', percent: 100, signature: unchecked ? 'unchecked' : 'verified' });
      return true;
    } catch (err) {
      setState({ phase: 'error', error: err.message });
      if (/^ERR_UPDATER_/.test(err?.code)) diagnostics?.markExpected?.(err);
      throw err;
    }
  }
  ipcMain.handle('updater:download', (_e, options) => download(options));

  // Starts the downloaded installer silently (it restarts Nano Studio) and quits. The installer closes it even if a window
  // refuses to close, so the renderer saves unsaved files first.
  function install() {
    if (state.phase !== 'downloaded') return false;
    setImmediate(() => getUpdater().quitAndInstall(true, true));
    return true;
  }
  ipcMain.handle('updater:install', install);

  // MSI installs: show the new .msi in the feed folder, or open its download link.
  async function openInstaller() {
    if (!feed || !state.available) return false;
    const name = `NanoStudio-${state.available}.msi`; // package.json build.msi.artifactName
    if (feed.dir) {
      const file = path.join(feed.dir, name);
      if (fs.existsSync(file)) shell.showItemInFolder(file);
      else await shell.openPath(feed.dir);
      return true;
    }
    await shell.openExternal(new URL(name, feed.url).href);
    return true;
  }
  ipcMain.handle('updater:openInstaller', openInstaller);

  // ---------- the start chooser ----------
  // It runs before any renderer of the app, so these read the settings the renderer's check reads.
  async function checkAtStart(settings) {
    const value = String(settings?.['updates.feedUrl'] ?? state.defaultFeed ?? '').trim();
    if (settings?.['updates.checkOnStartup'] === false || settings?.['powerSave.enabled'] === true || !value) return;
    // A folder feed is read with sync calls, which on a share that does not answer hold the main process for ~20 s.
    if (!/^https?:/i.test(value)) {
      const dir = /^file:/i.test(value) ? fileURLToPath(value) : value;
      const answers = await Promise.race([fs.promises.access(dir).then(() => true, () => true), new Promise((r) => { setTimeout(r, 3000, false); })]);
      if (!answers) return void log.warn(`update feed ${dir} does not answer`);
    }
    try { await check(value, { channel: settings?.['updates.channel'] }); } catch (err) { log.warn(`update check failed: ${err.message}`); }
  }
  // The update icon: one click downloads, the next installs. Another Nano Studio process may hold unsaved work, and the
  // installer closes every one of them, so it never starts by itself.
  async function updateNow(settings) {
    if (state.phase === 'downloaded') return void install();
    if (kind === 'msi') return void openInstaller();
    if (kind !== 'nsis' || !offered) return;
    try { await download({ differential: settings?.['updates.differential'] !== false }); } catch (err) { log.warn(`update download failed: ${err.message}`); }
  }

  app.on('before-quit', () => feed?.server?.close());
  return { state: () => state, checkAtStart, updateNow };
}
