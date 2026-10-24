// Diagnostics core, like the IntelliJ platform's idea.log and "IDE Internal Errors": the IDE log in
// <userData>/logs/pyide.log (rotated by size), and the internal errors collected from the main process, every renderer
// window, plugin loading and sidecar processes. main.js installs it before anything else, so Electron's own
// "A JavaScript error occurred in the main process" dialog never shows. The diagnostics plugin is the UI on top.
const fs = require('fs');
const path = require('path');
const url = require('url');
const { app, ipcMain, dialog, BrowserWindow } = require('electron');
const { scrubText } = require('./redact');

const LEVELS = { DEBUG: 10, INFO: 20, WARN: 30, ERROR: 40 };
const ROTATED_FILES = 5;
const MAX_ERRORS = 200;
const ELECTRON_DIALOG_TITLE = 'A JavaScript error occurred in the main process';
const started = Date.now();

// ---------- log file ----------
let logDir = null;
let logFile = null;
let fd = null;
let size = 0;
let minLevel = LEVELS.INFO;
let maxBytes = 10 * 1024 * 1024;
const original = { log: console.log, info: console.info, warn: console.warn, error: console.error };

const pad = (n, w = 2) => String(n).padStart(w, '0');
function stamp(d = new Date()) {
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())} ${pad(d.getHours())}:${pad(d.getMinutes())}:${pad(d.getSeconds())},${pad(d.getMilliseconds(), 3)}`;
}

function openLog() {
  fs.mkdirSync(logDir, { recursive: true });
  fd = fs.openSync(logFile, 'a');
  size = fs.fstatSync(fd).size;
}

// pyide.log -> pyide.1.log -> ... -> pyide.5.log, the oldest dropped.
function rotate() {
  try { fs.closeSync(fd); } catch {}
  fd = null;
  const name = (i) => path.join(logDir, i ? `pyide.${i}.log` : 'pyide.log');
  try { fs.rmSync(name(ROTATED_FILES), { force: true }); } catch {}
  for (let i = ROTATED_FILES - 1; i >= 0; i--) {
    try { if (fs.existsSync(name(i))) fs.renameSync(name(i), name(i + 1)); } catch {}
  }
  openLog();
}

// One entry: `2026-10-20 14:03:12,345 [   1234]   INFO - #category - message`, continuation lines as they are.
function write(level, category, message) {
  if (LEVELS[level] < minLevel || !logFile) return;
  const line = `${stamp()} [${String(Date.now() - started).padStart(7)}] ${level.padStart(6)} - ${category} - ${scrubText(message).replace(/\r?\n$/, '')}\n`;
  try {
    if (fd === null) openLog();
    const bytes = Buffer.byteLength(line);
    if (size > 0 && size + bytes > maxBytes) rotate();
    fs.writeSync(fd, line);
    size += bytes;
  } catch {}
}

const logger = (category) => ({
  debug: (msg) => write('DEBUG', category, String(msg)),
  info: (msg) => write('INFO', category, String(msg)),
  warn: (msg) => write('WARN', category, String(msg)),
  error: (msg) => write('ERROR', category, String(msg)),
});

function configure({ level, sizeMB } = {}) {
  const env = process.env;
  const lv = String(env.PYIDE_LOG_LEVEL || level || 'INFO').toUpperCase();
  minLevel = LEVELS[lv] ?? LEVELS.INFO;
  maxBytes = Number(env.PYIDE_LOG_MAX_BYTES) || Math.max(1, Number(sizeMB) || 10) * 1024 * 1024;
}

// ---------- internal errors ----------
const errors = [];
let nextErrorId = 1;
let resolveOwner = null; // file path -> {id, name, required, bundled} | null, from the plugin manager
let changedTimer = null;
const rawDialogs = [];
const watched = new Set();
// Main modules that failed to load (lower-case path -> message), for the Plugins page; clearing the error list keeps them.
const loadFailures = new Map();
// Errors an IPC handler threw that the renderer shows to the user (see install); Node error codes of the user's files.
const expectedErrors = new WeakSet();
const FS_USER_ERRORS = new Set(['EBUSY', 'EPERM', 'EACCES', 'ENOENT', 'EISDIR', 'ENOTDIR', 'EEXIST', 'ENOSPC', 'EROFS', 'ENAMETOOLONG', 'ELOOP', 'UNKNOWN']);
// Failures of the computer the IDE runs on rather than of the IDE: a folder it may not write, a full disk, a program that
// is not installed (spawn ENOENT), a network or server that does not answer. Whoever meets one tells the user.
const ENVIRONMENT_ERRORS = new Set(['EPERM', 'EACCES', 'ENOENT', 'ENOSPC', 'EROFS', 'EBUSY', 'ECONNREFUSED', 'ECONNRESET', 'ECONNABORTED',
  'ETIMEDOUT', 'ENOTFOUND', 'EAI_AGAIN', 'EHOSTUNREACH', 'ENETUNREACH', 'ENETDOWN']);
// A worker thread's error comes back as its message only ("EPERM: operation not permitted, mkdir '…'"), and Electron's
// net module names its errors in the message (net::ERR_CONNECTION_REFUSED).
function isEnvironmentError(err) {
  const message = String(err?.message ?? '');
  const code = err?.code || /^([A-Z][A-Z_]+):/.exec(message)?.[1];
  return ENVIRONMENT_ERRORS.has(code) || /^net::ERR_/.test(message);
}
function markExpected(err) {
  if (err && typeof err === 'object') err.expected = true;
  return err;
}
let quitting = false;

const errorText = (v) => {
  if (v instanceof Error) return { name: v.name, message: v.message, stack: v.stack || `${v.name}: ${v.message}` };
  if (v && typeof v === 'object' && 'message' in v) return { name: v.name || 'Error', message: String(v.message), stack: v.stack || String(v.message) };
  return { name: 'Error', message: String(v), stack: String(v) };
};

// Source files named in a stack trace, top frame first: node paths, file:// URLs (renderer) and plain paths.
function stackFiles(stack) {
  const out = [];
  for (const m of String(stack || '').matchAll(/((?:file:\/\/\/|[A-Za-z]:[\\/])[^()\n]*?)(?::\d+){1,2}(?=\)|\s*$)/gm)) {
    let f = m[1].trim();
    if (f.startsWith('file:')) {
      try { f = url.fileURLToPath(f.split(/[?#]/)[0]); } catch { continue; }
    }
    out.push(f);
  }
  return out;
}

const ownDir = __dirname.toLowerCase();
// The plugin a stack trace comes from: the first frame inside a plugin's folder or one of its main modules,
// skipping this module's own frames.
function ownerOfStack(stack, files = []) {
  if (!resolveOwner) return undefined;
  for (const f of [...files, ...stackFiles(stack)]) {
    if (f.toLowerCase().startsWith(ownDir)) continue;
    const owner = resolveOwner(f);
    if (owner) return owner;
  }
  return null;
}

function broadcast() {
  clearTimeout(changedTimer);
  changedTimer = setTimeout(() => {
    const summary = { count: errors.length, unread: errors.filter((e) => !e.read).length };
    for (const w of BrowserWindow.getAllWindows()) if (!w.isDestroyed()) w.webContents.send('diagnostics:changed', summary);
  }, 50);
}

// source: 'main' | 'renderer' | 'plugin' | 'sidecar'; window: 'main' | 'detached' for renderer errors.
// files: paths that identify the owning plugin directly (a main module that failed to load).
// plugin: the owner when the caller knows it; otherwise it comes from the stack.
function report({ source = 'main', kind = 'error', error, message, stack, window, files, title, plugin } = {}) {
  const e = error !== undefined ? errorText(error) : { name: 'Error', message: String(message ?? ''), stack: String(stack || message || '') };
  const text = message || e.message;
  const fullStack = stack || e.stack;
  if (kind === 'load') for (const f of files || []) loadFailures.set(path.resolve(f).toLowerCase(), scrubText(text));
  const signature = `${source}|${text}|${String(fullStack).split('\n').slice(0, 6).join('|')}`;
  const now = Date.now();
  let entry = errors.find((x) => x.signature === signature);
  if (entry) {
    entry.count++;
    entry.lastTime = now;
    entry.read = false;
  } else {
    entry = { id: nextErrorId++, signature, time: now, lastTime: now, count: 1, read: false, source, kind, window: window || null,
      title: title || null, message: scrubText(text), stack: scrubText(fullStack), files: files || [], plugin: plugin !== undefined ? plugin : ownerOfStack(fullStack, files) };
    errors.push(entry);
    if (errors.length > MAX_ERRORS) errors.shift();
  }
  // The log keeps the first occurrences in full; a repeating error is noted every 100th time.
  if (entry.count <= 10 || entry.count % 100 === 0) {
    const owner = entry.plugin ? ` [plugin ${entry.plugin.id}]` : '';
    const where = source === 'renderer' ? `#renderer.${window || 'main'}` : `#${source}`;
    write('ERROR', where, `${entry.count > 1 ? `(x${entry.count}) ` : ''}${title ? `${title}: ` : ''}${text}${owner}\n${fullStack}`);
  }
  broadcast();
  return entry.id;
}

function listErrors() {
  for (const e of errors) if (e.plugin === undefined) e.plugin = ownerOfStack(e.stack, e.files);
  return errors.map(({ signature, ...e }) => e);
}
function clearErrors() { errors.length = 0; broadcast(); }
const loadFailure = (file) => loadFailures.get(path.resolve(file).toLowerCase()) || null;
function markRead() { for (const e of errors) e.read = true; broadcast(); }

// ---------- sidecar processes ----------
// Logs a helper process's stderr and reports it as an internal error when it exits unexpectedly: not killed by the
// IDE, not while quitting, and with a non-zero exit code. The owning plugin comes from the caller's stack.
function watchProcess(proc, { name, plugin } = {}) {
  const owner = plugin || ownerOfStack(new Error().stack);
  const label = name || path.basename(proc.spawnfile || 'process');
  const log = logger(`#sidecar.${label}`);
  const tail = [];
  let partial = '';
  const item = { name: label, pid: proc.pid, plugin: owner?.id || null, proc };
  watched.add(item);
  log.info(`started (pid ${proc.pid})${owner ? ` for plugin ${owner.id}` : ''}`);
  proc.stderr?.on('data', (d) => {
    const lines = (partial + d.toString('utf8')).split(/\r?\n/);
    partial = lines.pop();
    for (const raw of lines) {
      const line = raw.split('\r').pop();
      if (!line.trim()) continue;
      tail.push(line);
      if (tail.length > 40) tail.shift();
      log.info(line);
    }
  });
  proc.on('exit', (code, signal) => {
    watched.delete(item);
    if (partial.trim()) { tail.push(partial); log.info(partial); }
    if (code === 0 || proc.killed || quitting) { log.info(`exited with code ${code ?? signal}`); return; }
    report({ source: 'sidecar', kind: 'crash', title: label,
      message: `${label} exited unexpectedly (exit code ${code ?? signal})`,
      stack: tail.length ? tail.join('\n') : `${label} exited unexpectedly (exit code ${code ?? signal})`,
      plugin: owner });
  });
  return proc;
}

// ---------- install ----------
function readSettings() {
  try { return JSON.parse(fs.readFileSync(path.join(app.getPath('userData'), 'settings.json'), 'utf8')) || {}; } catch { return {}; }
}

function install() {
  logDir = path.join(app.getPath('userData'), 'logs');
  logFile = path.join(logDir, 'pyide.log');
  const settings = readSettings();
  configure({ level: settings['diagnostics.logLevel'], sizeMB: settings['diagnostics.logSizeMB'] });

  // With a listener of our own, Electron's default handler (which shows the raw error dialog) stands down.
  process.on('uncaughtException', (err) => report({ source: 'main', kind: 'uncaught', error: err }));
  process.on('unhandledRejection', (reason) => report({ source: 'main', kind: 'rejection', error: reason }));
  // Anything else that still asks for Electron's main-process error box becomes an internal error instead.
  const showErrorBox = dialog.showErrorBox.bind(dialog);
  dialog.showErrorBox = (title, content) => {
    rawDialogs.push({ title, content });
    if (title === ELECTRON_DIALOG_TITLE) report({ source: 'main', kind: 'uncaught', message: String(content).split('\n')[1] || title, stack: content });
    else showErrorBox(title, content);
  };

  // console output of the main process (plugins included) goes to the log; console.error(…, err) is an internal error.
  const toText = (a) => (a instanceof Error ? a.stack : typeof a === 'string' ? a : (() => { try { return JSON.stringify(a); } catch { return String(a); } })());
  for (const [method, level] of [['log', 'INFO'], ['info', 'INFO'], ['warn', 'WARN'], ['error', 'ERROR']]) {
    console[method] = (...args) => {
      try { original[method](...args); } catch {}
      const err = args.find((a) => a instanceof Error);
      if (level === 'ERROR' && err && !expectedErrors.has(err) && !err.expected && !isEnvironmentError(err)) {
        const message = args.map((a) => (a instanceof Error ? `${a.name}: ${a.message}` : toText(a))).join(' ');
        report({ source: 'main', kind: 'logged', message, stack: err.stack });
      } else write(level, '#console', args.map(toText).join(' '));
    };
  }

  // IPC handlers that throw answer the renderer with the error; the log keeps the stack. Errors about the user's files
  // in the core fs: handlers (a file another program holds, a read-only file, a folder opened as a file), failures of
  // the environment on any channel, and errors a handler marks `expected` (a language server that did not answer in
  // time) are the renderer's to show; they are not IDE internal errors, which Electron's "Error occurred in handler"
  // console line would otherwise make them.
  const handle = ipcMain.handle.bind(ipcMain);
  const ipcLog = logger('#ipc');
  ipcMain.handle = (channel, fn) => handle(channel, async (...args) => {
    try { return await fn(...args); } catch (err) {
      ipcLog.warn(`${channel} failed: ${err?.stack || err}`);
      if (err instanceof Error && (err.expected || isEnvironmentError(err) || (channel.startsWith('fs:') && FS_USER_ERRORS.has(err.code)))) expectedErrors.add(err);
      throw err;
    }
  });

  // Renderer windows report their errors and log lines here (renderer/core/diagnostics.js).
  ipcMain.on('diagnostics:report', (_e, p = {}) => report({ source: 'renderer', kind: p.kind, message: p.message, stack: p.stack, window: p.window }));
  ipcMain.on('diagnostics:log', (_e, p = {}) => write(LEVELS[p.level] ? p.level : 'INFO', String(p.category || '#renderer'), String(p.message ?? '')));

  app.on('render-process-gone', (_e, wc, details) => {
    if (details.reason === 'clean-exit' || quitting) return;
    report({ source: 'renderer', kind: 'crash', message: `Renderer process gone: ${details.reason} (exit code ${details.exitCode})`, stack: wc?.getURL?.() || '' });
  });
  app.on('child-process-gone', (_e, details) => {
    if (details.reason === 'clean-exit' || quitting) return;
    report({ source: 'main', kind: 'crash', message: `${details.type} process gone: ${details.reason} (exit code ${details.exitCode})`, stack: details.name || details.type });
  });
  app.on('before-quit', () => { quitting = true; });
  app.on('will-quit', () => write('INFO', '#main', '------------------- IDE SHUTDOWN -------------------'));

  // Test hooks for verify/diagnostics.mjs; absent unless PYIDE_DIAGNOSTICS_TEST=1.
  if (process.env.PYIDE_DIAGNOSTICS_TEST === '1') {
    ipcMain.handle('diagnostics:test', (_e, action) => {
      if (action === 'uncaught') setTimeout(() => { throw new Error('diagnostics test: uncaught main-process exception'); }, 0);
      else if (action === 'rejection') Promise.reject(new Error('diagnostics test: unhandled main-process rejection'));
      else if (action === 'rawDialogs') return rawDialogs.map((d) => d.title);
      else if (action === 'processes') return [...watched].map(({ name, pid, plugin }) => ({ name, pid, plugin }));
      return true;
    });
  }

  write('INFO', '#main', '------------------- IDE STARTED -------------------');
  write('INFO', '#main', `PyIDE ${app.getVersion()}, Electron ${process.versions.electron}, Chromium ${process.versions.chrome}, Node ${process.versions.node}`);
  write('INFO', '#main', `${process.platform} ${process.arch}, userData ${app.getPath('userData')}`);
  return api;
}

// The plugin manager is created after install(); errors reported before then are attributed when listed.
function setPluginResolver(fn) { resolveOwner = fn; }

const api = {
  install, setPluginResolver, configure, logger, report, listErrors, clearErrors, markRead, watchProcess, isEnvironmentError, markExpected, loadFailure,
  logFile: () => logFile, logDir: () => logDir,
};
module.exports = api;
