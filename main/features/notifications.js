// The notifications event log: the last 200 notifications, kept across restarts in <userData>/notifications/log.json.
// The renderer appends each notification of the session; `notifications:previous` answers what the log held when
// PyIDE started, so the tool window can show earlier sessions below this one.
const fs = require('fs');
const path = require('path');

const LIMIT = 200;
// The saved log keeps the start of long texts only (a failed command's output can be tens of KB).
const TITLE_MAX = 500;
const TEXT_MAX = 2000;
// A burst of notifications (a test run, a batch of failures) is written once, this long after the first of them.
const WRITE_DELAY = 250;

function register({ ipcMain, app }) {
  const dir = path.join(app.getPath('userData'), 'notifications');
  const file = path.join(dir, 'log.json');
  const clean = (e) => (e && typeof e === 'object' && typeof e.title === 'string' && Number.isFinite(e.time) ? {
    time: e.time, title: e.title.slice(0, TITLE_MAX), text: typeof e.text === 'string' ? e.text.slice(0, TEXT_MAX) : '',
    kind: ['info', 'ok', 'warn', 'error'].includes(e.kind) ? e.kind : 'info', group: typeof e.group === 'string' ? e.group.slice(0, 200) : '', raw: !!e.raw,
  } : null);
  let log;
  try { log = JSON.parse(fs.readFileSync(file, 'utf8')); } catch { log = []; }
  log = (Array.isArray(log) ? log : []).map(clean).filter(Boolean).slice(-LIMIT);
  const previous = log.slice();

  // Writes go to a temp file that then replaces the log, so a crash mid-write leaves the old log whole. They run one
  // at a time, off the main thread; whatever is still unsaved when PyIDE quits is written synchronously on will-quit.
  let timer = null;
  let dirty = false;
  let writes = Promise.resolve();
  let closed = false;
  const tmp = `${file}.tmp`;
  const warn = (err) => console.warn('notifications: could not save the event log', err.message);

  async function write() {
    if (!dirty || closed) return;
    dirty = false;
    const data = JSON.stringify(log);
    try {
      await fs.promises.mkdir(dir, { recursive: true });
      await fs.promises.writeFile(tmp, data);
      if (!closed) await fs.promises.rename(tmp, file);
    } catch (err) { warn(err); }
  }
  function flush() {
    timer = null;
    writes = writes.then(write);
  }
  function schedule() {
    dirty = true;
    if (!timer && !closed) timer = setTimeout(flush, WRITE_DELAY);
  }
  function flushSync() {
    if (timer) { clearTimeout(timer); timer = null; }
    closed = true;
    if (!dirty) return;
    dirty = false;
    try {
      fs.mkdirSync(dir, { recursive: true });
      fs.writeFileSync(`${file}.quit.tmp`, JSON.stringify(log));
      fs.renameSync(`${file}.quit.tmp`, file);
    } catch (err) { warn(err); }
  }
  app.on?.('will-quit', flushSync);

  ipcMain.handle('notifications:previous', () => previous);
  ipcMain.handle('notifications:append', (_e, entries) => {
    const added = (Array.isArray(entries) ? entries : [entries]).map(clean).filter(Boolean);
    if (!added.length) return;
    log = log.concat(added).slice(-LIMIT);
    schedule();
  });
  ipcMain.handle('notifications:clear', () => {
    log = [];
    previous.length = 0;
    schedule();
  });
  // For verify/notifications-log.mjs: write what is pending now, as on quit, and wait for any write in progress.
  return { flushSync, idle: () => writes };
}

module.exports = { register, WRITE_DELAY, TEXT_MAX };
