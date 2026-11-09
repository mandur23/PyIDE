// Main side of Nano Studio Cut (renderer/features/cut, mode 'cut'): every byte of a media file, project, font or cache
// entry the editor uses comes through these cut:* channels, since the renderer cannot read files itself. The folders
// live in the Cut workspace (PYIDE_CUT_HOME for tests): Projects, Autosave and Cache. Paths from the renderer go
// through main/cut/paths.js (local regular files, real paths, no network paths); results are values, never throws.
//
// PYIDE_CUT_DIALOG (tests): a JSON file {pickMedia, pickFolder, pickProject, pickLut, saveAs} whose value answers that dialog
// instead of showing it (null or missing: cancelled). PYIDE_CUT_FONT_DIRS (tests): a JSON list of font folders.
const fs = require('fs');
const os = require('os');
const path = require('path');
const { BrowserWindow, dialog, shell } = require('electron');
const { READ_LIMIT } = require('../cut/limits');
const { MEDIA, READABLE, fail, localPath, realEntry, realFile } = require('../cut/paths');
const { createRun } = require('../cut/runs');
const { createProjects } = require('../cut/project');
const { createSinks } = require('../cut/sink');
const { createCache } = require('../cut/cache');
const { faststart } = require('../cut/faststart');
const { findMedia, listMedia } = require('../cut/find');
const { createFonts, fontDirs } = require('../cut/fonts');
const { createSpeech } = require('../cut/whisper');
const { createSpeakers } = require('../cut/speakers');
const { createVoice } = require('../cut/voice');
const { createAi } = require('../cut/ai');
const { createControl } = require('../cut/control');
const { createAgent } = require('../cut/agent');

const CACHE_LIMIT_SETTING = 'cut.cacheLimitGB';
const DEFAULT_CACHE_GB = 10;
const CHECK_TTL_MS = 2000;
const GB = 1024 ** 3;

const cutHome = () => path.resolve(process.env.PYIDE_CUT_HOME || path.join(os.homedir(), 'Nano Studio Cut'));
const readJson = (p) => { try { return JSON.parse(fs.readFileSync(p, 'utf8')); } catch { return null; } };
const text = (v, fallback, max = 200) => (typeof v === 'string' && v.trim() ? v.slice(0, max) : fallback);

function register({ ipcMain, app, getWindow, diagnostics, unpackedDir }) {
  const log = diagnostics?.logger?.('#cut');
  const home = cutHome();
  const dirs = { home, projects: path.join(home, 'Projects'), autosave: path.join(home, 'Autosave'), cache: path.join(home, 'Cache') };
  const run = createRun();
  const settingsFile = path.join(app.getPath('userData'), 'settings.json');
  const cacheLimit = () => {
    const gb = Number(readJson(settingsFile)?.[CACHE_LIMIT_SETTING]);
    return Math.floor((Number.isFinite(gb) && gb > 0 ? gb : DEFAULT_CACHE_GB) * GB);
  };
  let envFonts = null;
  try { envFonts = process.env.PYIDE_CUT_FONT_DIRS ? JSON.parse(process.env.PYIDE_CUT_FONT_DIRS) : null; } catch {}
  const fonts = createFonts(Array.isArray(envFonts) ? envFonts.map(String) : fontDirs());
  const projects = createProjects({ autosaveDir: dirs.autosave, run, log });
  const checked = new Map(); // lower-case path as asked -> {real, at}: cut:read checks a path once per CHECK_TTL_MS
  const forgetChecks = () => checked.clear();
  let cache = null;
  const sinks = createSinks({
    journalDir: path.join(app.getPath('userData'), 'cut-exports'),
    run,
    log,
    onCommit: async (file) => { forgetChecks(); await cache.added(file); },
  });
  cache = createCache({ dir: dirs.cache, limit: cacheLimit, busy: () => sinks.openParts(), log });
  sinks.sweep().catch((err) => log?.warn?.(`export cleanup: ${err.message}`));
  const speech = createSpeech({ script: path.join(unpackedDir || path.join(__dirname, '..', '..'), 'main', 'ai', 'whisper_server.py'), log });
  const speakers = createSpeakers({ script: path.join(unpackedDir || path.join(__dirname, '..', '..'), 'main', 'ai', 'speaker_server.py'), speech, log });
  const voice = createVoice({
    script: path.join(unpackedDir || path.join(__dirname, '..', '..'), 'main', 'ai', 'voice_server.py'),
    mediaDir: path.join(home, 'Media'), cacheDir: dirs.cache, onCached: (file) => cache.added(file), log,
  });
  const ai = createAi({ log });
  const control = createControl({ configFile: path.join(app.getPath('userData'), 'cut-control.json'), log, version: app.getVersion?.() || '0' });
  const agent = createAgent({ control, log });

  const watched = new Set();
  function watch(wc) {
    if (!wc || typeof wc.once !== 'function' || watched.has(wc.id)) return;
    watched.add(wc.id);
    const id = wc.id;
    wc.on('render-process-gone', (_e, details) => {
      if (details?.reason === 'clean-exit') return;
      sinks.ownerGone(id).catch(() => {});
      projects.ownerGone(id, { crashed: true }).catch(() => {});
    });
    wc.once('destroyed', () => {
      watched.delete(id);
      sinks.ownerGone(id).catch(() => {});
      projects.ownerGone(id, { crashed: false }).catch(() => {});
      speakers.ownerGone(id);
      speech.ownerGone(id).catch(() => {});
      voice.ownerGone(id).catch(() => {});
      ai.ownerGone(id);
      agent.ownerGone(id);
      if (controlPage === wc) { controlPage = null; control.abandon(); }
    });
  }
  // Every channel learns its window, so what a window opened is cleaned up when it goes.
  const handle = (channel, fn) => ipcMain.handle(channel, (e, ...args) => {
    watch(e?.sender);
    return fn(e?.sender?.id ?? 0, ...args);
  });

  handle('cut:home', async () => {
    for (const d of Object.values(dirs)) await fs.promises.mkdir(d, { recursive: true }).catch((err) => log?.warn?.(`cannot create ${d}: ${err.message}`));
    return { ...dirs };
  });

  handle('cut:stat', async (_o, p) => {
    const entry = await realEntry(p);
    if (entry.code === 'missing') return { missing: true };
    if (entry.error) return { missing: true, ...entry };
    return { size: entry.stat.size, mtime: entry.stat.mtimeMs, isFile: entry.stat.isFile(), path: entry.real };
  });

  async function readable(p) {
    const k = typeof p === 'string' ? p.toLowerCase() : '';
    const hit = checked.get(k);
    if (hit && Date.now() - hit.at < CHECK_TTL_MS) return hit;
    const file = await realFile(p, READABLE);
    if (file.error) { checked.delete(k); return file; }
    if (checked.size > 512) checked.clear();
    const v = { real: file.real, at: Date.now() };
    checked.set(k, v);
    return v;
  }
  handle('cut:read', async (_o, p, offset, length) => {
    if (!Number.isSafeInteger(offset) || offset < 0 || !Number.isSafeInteger(length) || length < 0) return fail('badArgs', 'read takes an offset and a length');
    if (length > READ_LIMIT) return fail('tooLarge', `one read is ${READ_LIMIT / 1024 / 1024} MB at most`);
    const file = await readable(p);
    if (file.error) return file;
    let fh;
    try {
      fh = await fs.promises.open(file.real, 'r');
      const { size } = await fh.stat();
      const want = Math.max(0, Math.min(length, size - offset));
      const buf = new Uint8Array(want);
      let done = 0;
      while (done < want) {
        const { bytesRead } = await fh.read(buf, done, want - done, offset + done);
        if (!bytesRead) break;
        done += bytesRead;
      }
      cache.used(file.real).catch(() => {});
      return done < want ? buf.slice(0, done) : buf;
    } catch (err) {
      checked.delete(typeof p === 'string' ? p.toLowerCase() : '');
      return err.code === 'ENOENT' ? fail('missing', 'no such file') : fail('io', err.message);
    } finally { await fh?.close().catch(() => {}); }
  });

  // ---------- dialogs ----------
  const windowOf = (e) => BrowserWindow?.fromWebContents?.(e?.sender) || getWindow?.() || undefined;
  function answered(name) {
    try { const v = readJson(process.env.PYIDE_CUT_DIALOG)?.[name]; return v === undefined ? null : v; } catch { return null; }
  }
  const mediaFilter = (name) => ({ name, extensions: [...MEDIA] });
  // Titles and filter names come from the renderer in the UI's language; these are the English fallbacks.
  ipcMain.handle('cut:pickMedia', async (e, opts = {}) => {
    watch(e?.sender);
    if (process.env.PYIDE_CUT_DIALOG) return answered('pickMedia');
    const r = await dialog.showOpenDialog(windowOf(e), {
      title: text(opts?.title, 'Import Media'),
      defaultPath: typeof opts?.defaultPath === 'string' && !localPath(opts.defaultPath).error ? opts.defaultPath : undefined,
      properties: ['openFile', ...(opts?.multi === false ? [] : ['multiSelections'])],
      filters: [mediaFilter(text(opts?.filterName, 'Media files')), { name: text(opts?.allName, 'All files'), extensions: ['*'] }],
    });
    return r.canceled || !r.filePaths.length ? null : r.filePaths;
  });
  ipcMain.handle('cut:pickFolder', async (e, opts = {}) => {
    watch(e?.sender);
    if (process.env.PYIDE_CUT_DIALOG) return answered('pickFolder');
    const r = await dialog.showOpenDialog(windowOf(e), { title: text(opts?.title, 'Choose a Folder'), properties: ['openDirectory'] });
    return r.canceled || !r.filePaths.length ? null : r.filePaths[0];
  });
  ipcMain.handle('cut:pickProject', async (e, opts = {}) => {
    watch(e?.sender);
    if (process.env.PYIDE_CUT_DIALOG) return answered('pickProject');
    await fs.promises.mkdir(dirs.projects, { recursive: true }).catch(() => {});
    const r = await dialog.showOpenDialog(windowOf(e), {
      title: text(opts?.title, 'Open Project'),
      defaultPath: dirs.projects,
      properties: ['openFile'],
      filters: [{ name: text(opts?.filterName, 'Nano Studio Cut project'), extensions: ['ncut'] }],
    });
    return r.canceled || !r.filePaths.length ? null : r.filePaths[0];
  });
  // Lumetri Color's Look: one .cube file (the renderer reads it through cut:read and keeps a copy in the project).
  ipcMain.handle('cut:pickLut', async (e, opts = {}) => {
    watch(e?.sender);
    if (process.env.PYIDE_CUT_DIALOG) return answered('pickLut');
    const r = await dialog.showOpenDialog(windowOf(e), {
      title: text(opts?.title, 'Load LUT'),
      properties: ['openFile'],
      filters: [{ name: text(opts?.filterName, 'Cube LUT'), extensions: ['cube'] }, { name: text(opts?.allName, 'All files'), extensions: ['*'] }],
    });
    return r.canceled || !r.filePaths.length ? null : r.filePaths[0];
  });
  ipcMain.handle('cut:saveAs', async (e, opts = {}) => {
    watch(e?.sender);
    const filters = (Array.isArray(opts?.filters) ? opts.filters : []).slice(0, 10)
      .filter((f) => f && typeof f.name === 'string' && Array.isArray(f.extensions))
      .map((f) => ({ name: f.name.slice(0, 100), extensions: f.extensions.filter((x) => typeof x === 'string' && /^[a-z0-9]{1,10}$/i.test(x)) }))
      .filter((f) => f.extensions.length);
    let chosen;
    if (process.env.PYIDE_CUT_DIALOG) chosen = answered('saveAs');
    else {
      await fs.promises.mkdir(dirs.projects, { recursive: true }).catch(() => {});
      const given = typeof opts?.defaultPath === 'string' ? opts.defaultPath : '';
      const defaultPath = !given ? dirs.projects : localPath(given).error ? path.join(dirs.projects, path.basename(given)) : given;
      const r = await dialog.showSaveDialog(windowOf(e), { title: text(opts?.title, 'Save As'), defaultPath, filters: filters.length ? filters : undefined });
      chosen = r.canceled ? null : r.filePath || null;
    }
    if (typeof chosen !== 'string' || !chosen) return null;
    if (!path.extname(chosen) && filters[0]) chosen += `.${filters[0].extensions[0]}`;
    return chosen;
  });

  // ---------- projects, autosave, recovery ----------
  handle('cut:projectRead', (_o, p) => projects.projectRead(p));
  handle('cut:projectWrite', async (_o, p, t) => {
    const r = await projects.projectWrite(p, t);
    if (r.ok) forgetChecks();
    return r;
  });
  handle('cut:autosave', (_o, key, t, opts) => projects.autosave(key, t, opts && typeof opts === 'object' ? { latest: opts.latest === true, keep: opts.keep } : {}));
  handle('cut:sessionStart', (owner, key) => projects.sessionStart(key, owner));
  handle('cut:sessionEnd', (owner, key) => projects.sessionEnd(key, owner));
  handle('cut:recovery', () => projects.recovery());
  handle('cut:recoveryDismiss', (_o, key) => projects.dismiss(key));

  // ---------- export sink ----------
  handle('cut:writeOpen', (owner, p) => sinks.open(owner, p));
  handle('cut:writeAt', (owner, id, bytes, position) => sinks.write(owner, id, bytes, position));
  handle('cut:writeClose', (owner, id, opts) => sinks.close(owner, id, opts || {}));
  handle('cut:faststart', async (_o, p) => {
    const r = await faststart(p);
    if (r.moved) forgetChecks();
    return r;
  });

  // ---------- cache ----------
  handle('cut:cacheGet', (_o, key) => cache.get(key));
  handle('cut:cachePut', (_o, key, bytes) => cache.put(key, bytes));
  handle('cut:cacheInfo', () => cache.info());
  handle('cut:cacheClear', () => cache.clear());

  // ---------- relink, folder import, fonts, Explorer ----------
  handle('cut:findMedia', (_o, folder, wanted) => findMedia(folder, wanted));
  handle('cut:listMedia', (_o, folder) => listMedia(folder));
  handle('cut:fonts', async () => {
    try { return await fonts.list(); } catch (err) { return fail('io', err.message); }
  });
  handle('cut:fontData', (_o, file, index) => fonts.data(file, index));
  handle('cut:reveal', async (_o, p) => {
    const entry = await realEntry(p);
    if (entry.error) return entry.code === 'missing' ? { missing: true } : entry;
    shell.showItemInFolder(entry.real);
    return { ok: true };
  });

  // ---------- speech recognition (main/cut/whisper.js) ----------
  handle('cut:speechStatus', () => speech.status());
  ipcMain.handle('cut:speechSetup', (e, opts) => { watch(e?.sender); return speech.setup(opts?.model, e?.sender); });
  handle('cut:speechCancelSetup', () => speech.cancelSetup());
  handle('cut:speechConfigure', (_o, opts) => speech.configure(opts && typeof opts === 'object' ? opts : {}));
  handle('cut:speechOpen', (owner) => speech.open(owner));
  handle('cut:speechWrite', (owner, id, bytes) => speech.write(owner, id, bytes));
  ipcMain.handle('cut:speechTranscribe', (e, id, opts) => { watch(e?.sender); return speech.transcribe(e?.sender?.id ?? 0, id, opts && typeof opts === 'object' ? opts : {}, e?.sender); });
  handle('cut:speechCancel', (owner, request) => speech.cancel(owner, request));
  handle('cut:speechClose', (owner, id) => speech.close(owner, id));
  handle('cut:speechTestConfig', (_o, cfg) => speech.testConfig(cfg && typeof cfg === 'object' ? cfg : {}));
  app.on?.('before-quit', () => { speech.dispose().catch(() => {}); });

  // ---------- speaker labels (main/cut/speakers.js), on the sound files of speech recognition ----------
  handle('cut:speakersStatus', () => speakers.status());
  ipcMain.handle('cut:speakersSetup', (e) => { watch(e?.sender); return speakers.setup(e?.sender); });
  handle('cut:speakersCancelSetup', () => speakers.cancelSetup());
  handle('cut:speakersConfigure', (_o, opts) => speakers.configure(opts && typeof opts === 'object' ? opts : {}));
  handle('cut:speakersEmbed', (owner, id, opts) => speakers.embed(owner, id, opts && typeof opts === 'object' ? opts : {}));
  handle('cut:speakersCancel', (owner, request) => speakers.cancel(owner, request));
  handle('cut:speakersTestConfig', (_o, cfg) => speakers.testConfig(cfg && typeof cfg === 'object' ? cfg : {}));
  app.on?.('before-quit', () => { speakers.dispose().catch(() => {}); });

  // ---------- voice isolation (main/cut/voice.js) ----------
  handle('cut:voiceStatus', () => voice.status());
  ipcMain.handle('cut:voiceSetup', (e) => { watch(e?.sender); return voice.setup(e?.sender); });
  handle('cut:voiceCancelSetup', () => voice.cancelSetup());
  handle('cut:voiceConfigure', (_o, opts) => voice.configure(opts && typeof opts === 'object' ? opts : {}));
  handle('cut:voiceFind', (_o, opts) => voice.find(opts && typeof opts === 'object' ? opts : {}));
  handle('cut:voiceOpen', (owner, opts) => voice.open(owner, opts && typeof opts === 'object' ? opts : {}));
  handle('cut:voiceWrite', (owner, id, bytes) => voice.write(owner, id, bytes));
  ipcMain.handle('cut:voiceSeparate', (e, id, opts) => { watch(e?.sender); return voice.separate(e?.sender?.id ?? 0, id, opts && typeof opts === 'object' ? opts : {}, e?.sender); });
  handle('cut:voiceCancel', (owner, request) => voice.cancel(owner, request));
  handle('cut:voiceClose', (owner, id) => voice.close(owner, id));
  handle('cut:voiceTestConfig', (_o, cfg) => voice.testConfig(cfg && typeof cfg === 'object' ? cfg : {}));
  app.on?.('before-quit', () => { voice.dispose().catch(() => {}); });

  // ---------- text AI through Claude Code (main/cut/ai.js): text in, text out ----------
  handle('cut:aiStatus', () => ai.status());
  ipcMain.handle('cut:aiComplete', (e, req) => { watch(e?.sender); return ai.run(e?.sender?.id ?? 0, req, e?.sender); });
  handle('cut:aiCancel', (owner, request) => ai.cancel(owner, request));

  // ---------- the control API and the AI assistant (main/cut/control.js, main/cut/agent.js) ----------
  // The page that answers tool calls is the one that listed the tools last; a reloaded page lists them again, and
  // what the old one left unanswered ends as errors.
  let controlPage = null;
  control.setTarget((channel, payload) => {
    const wc = controlPage && !controlPage.isDestroyed?.() ? controlPage : null;
    if (!wc) return false;
    try { wc.send(channel, payload); return true; } catch { return false; }
  });
  control.onClients((state) => { try { if (controlPage && !controlPage.isDestroyed?.()) controlPage.send('cut:controlClients', state); } catch {} });
  ipcMain.handle('cut:controlTools', (e, list, instructions) => {
    watch(e?.sender);
    control.abandon();
    controlPage = e?.sender || null;
    return control.setTools(list, instructions);
  });
  ipcMain.on('cut:controlResult', (e, msg) => { if (e?.sender === controlPage) control.answer(msg); });
  ipcMain.on('cut:controlProgress', (e, msg) => { if (e?.sender === controlPage) control.progress(msg); });
  handle('cut:controlExternal', (_o, on) => control.setExternal(on === true));
  handle('cut:controlDisconnect', () => control.disconnect());
  handle('cut:controlClients', () => ({ external: control.connected() }));
  ipcMain.handle('cut:agentRun', (e, req) => { watch(e?.sender); return agent.run(e?.sender?.id ?? 0, req, e?.sender); });
  handle('cut:agentStop', (owner, turn) => agent.stop(owner, turn));
  app.on?.('will-quit', () => { control.close(); });

  return { dirs, run, speech, speakers, voice, ai, control, agent };
}

module.exports = { register, cutHome };
