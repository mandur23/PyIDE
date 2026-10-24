// Crash recovery of unsaved edits (renderer/features/recovery). Each PyIDE process keeps its backups in its own
// session folder, <userData>/backups/<pid>-<start time>/. A clean quit removes the folder. A folder whose process is gone
// (a crash, a killed process, a power cut) holds the backups offered for restore; a live process's folder is never
// offered or removed, however long it has been quiet (a laptop asleep for a day), so two PyIDE instances sharing the
// user data leave each other's backups alone.
//
// A backup file is one line of JSON metadata ({path, name, untitled, project, language, encoding, lineSeparator,
// diskHash, asText, time}), a line break, then the document's text, written to a temporary file and renamed over the
// old one. Its name is a hash of the document's identity, so windows editing the same document (the text is shared
// through this process) write one file, which is removed only once no window holds it.
const fs = require('fs');
const os = require('os');
const path = require('path');
const crypto = require('crypto');

const TICK_MS = 10000;
const MAX_AGE_MS = 30 * 24 * 3600000;
// A session counts as started before this computer did only by more than this, so a clock set forward after the
// start (a time sync) does not make a running session look like one from before a restart.
const BOOT_SLACK_MS = 10 * 60000;
const SESSION = /^(\d+)-(\d+)$/;
const REF = /^\d+-\d+\/[0-9a-f]{40}\.backup$/;

const fileOf = (id) => `${crypto.createHash('sha1').update(String(id)).digest('hex')}.backup`;
const samePath = (a, b) => !!a && !!b && path.resolve(a).toLowerCase() === path.resolve(b).toLowerCase();
const list = (dir) => { try { return fs.readdirSync(dir); } catch { return []; } };

// The metadata line alone: listing must not read every backed-up text, which can be megabytes per file.
function readMeta(file) {
  let fd = null;
  try {
    fd = fs.openSync(file, 'r');
    const buf = Buffer.alloc(65536);
    const head = buf.subarray(0, fs.readSync(fd, buf, 0, buf.length, 0));
    const nl = head.indexOf(10);
    const meta = nl < 0 ? null : JSON.parse(head.toString('utf8', 0, nl));
    return meta && typeof meta === 'object' ? meta : null;
  } catch { return null; } finally {
    if (fd !== null) fs.closeSync(fd);
  }
}
function readText(file) {
  try {
    const raw = fs.readFileSync(file, 'utf8');
    return raw.slice(raw.indexOf('\n') + 1);
  } catch { return null; }
}

// A project folder missing from a drive that is there. A removable drive or a network share that is not connected
// keeps its backups.
function projectGone(dir) {
  const root = path.parse(dir).root;
  return !root.startsWith('\\\\') && fs.existsSync(root) && !fs.existsSync(dir);
}

function register({ ipcMain, app, getWindow }) {
  const root = path.join(app.getPath('userData'), 'backups');
  const session = `${process.pid}-${Date.now()}`;
  const own = path.join(root, session);
  const holders = new Map(); // backup file name -> Set of webContents ids
  // Backups of a window whose renderer crashed: nobody answered a save prompt for them, so they outlive a clean quit.
  const kept = new Set();
  const windows = new Map(); // webContents id -> webContents, for every window that backs up
  let project = null;
  let quitting = false;
  let opened = false;

  // session.json ({pid, beat}) is no longer read; PyIDE 0.2.6 and older running beside this one judge the folder by it.
  function writeSession() {
    const file = path.join(own, 'session.json');
    fs.writeFileSync(`${file}.tmp`, JSON.stringify({ pid: process.pid, beat: Date.now() }));
    fs.renameSync(`${file}.tmp`, file);
  }
  // The folder can disappear under a running session (deleted by hand or by a cleaner). It is made again on the next
  // backup or tick, and the windows are asked to write the backups they hold again.
  function openSession(beat = false) {
    const made = !!fs.mkdirSync(own, { recursive: true });
    opened = true;
    if (made || beat) writeSession();
    if (made && holders.size) for (const wc of windows.values()) if (!wc.isDestroyed()) wc.send('recovery:lost');
  }
  const tick = setInterval(() => { if (opened && !quitting) try { openSession(true); } catch {} }, TICK_MS);
  tick.unref();
  const remove = (file) => { try { fs.unlinkSync(path.join(own, file)); } catch {} };

  function release(wcId, file) {
    const set = holders.get(file);
    if (!set?.delete(wcId) || set.size) return;
    holders.delete(file);
    remove(file);
  }
  const releaseAll = (wcId) => { for (const file of [...holders.keys()]) release(wcId, file); };
  function keepAll(wcId) {
    for (const [file, set] of holders) {
      if (!set.delete(wcId) || set.size) continue;
      holders.delete(file);
      kept.add(file);
    }
  }
  function watch(wc) {
    const id = wc.id;
    if (windows.has(id)) return;
    windows.set(id, wc);
    wc.on('render-process-gone', (_e, details) => { if (details.reason !== 'clean-exit') keepAll(id); });
    wc.once('destroyed', () => { windows.delete(id); releaseAll(id); });
  }

  // A session is over once its process is gone. Its pid is trusted only if the session started after this computer
  // did: after a restart the pid may belong to another program. This process's own pid in another folder was an
  // earlier PyIDE.
  function alive(dir) {
    const [, pid, started] = SESSION.exec(dir).map(Number);
    if (pid === process.pid || started < Date.now() - os.uptime() * 1000 - BOOT_SLACK_MS) return false;
    try { process.kill(pid, 0); return true; } catch (err) { return err.code === 'EPERM'; }
  }
  const deadSessions = () => list(root).filter((d) => d !== session && SESSION.test(d) && !alive(d));
  function removeIfEmpty(dir) {
    if (!list(path.join(root, dir)).some((f) => f.endsWith('.backup'))) fs.rmSync(path.join(root, dir), { recursive: true, force: true });
  }

  // A page that loads again (a reload, Trust Project) starts without the documents its previous page held.
  ipcMain.handle('recovery:hello', (e) => { releaseAll(e.sender.id); watch(e.sender); });

  ipcMain.handle('recovery:project', (e, dir) => {
    if (e.sender === getWindow()?.webContents) project = typeof dir === 'string' && dir ? dir : null;
  });

  // rec: {id, text, ...metadata}; id names the document (its lower-case path, or untitled:<name>).
  ipcMain.handle('recovery:put', (e, rec) => {
    if (quitting || !rec || typeof rec.id !== 'string' || typeof rec.text !== 'string') return false;
    watch(e.sender);
    openSession();
    const { id, text, ...meta } = rec;
    const file = fileOf(id);
    const target = path.join(own, file);
    fs.writeFileSync(`${target}.tmp`, `${JSON.stringify({ ...meta, project })}\n${text}`);
    fs.renameSync(`${target}.tmp`, target);
    (holders.get(file) || holders.set(file, new Set()).get(file)).add(e.sender.id);
    kept.delete(file);
    return true;
  });

  ipcMain.handle('recovery:drop', (e, id) => { release(e.sender.id, fileOf(id)); });

  // Backups left by dead sessions for `dir` (and those made with no project open), oldest first, without their text
  // (recovery:text reads it). A document backed up by several dead sessions is listed once, with its newest backup as
  // `ref` and every file in refs. Backups older than 30 days, or of a project that no longer exists, are deleted here.
  ipcMain.handle('recovery:pending', (_e, dir) => {
    const byDoc = new Map();
    const gone = new Map(); // project -> projectGone(project), asked once per listing
    const projectMissing = (p) => (gone.has(p) ? gone.get(p) : gone.set(p, projectGone(p)).get(p));
    const old = (file) => { try { return Date.now() - fs.statSync(file).mtimeMs > MAX_AGE_MS; } catch { return false; } };
    for (const d of deadSessions()) {
      for (const f of list(path.join(root, d)).filter((x) => x.endsWith('.backup'))) {
        const file = path.join(root, d, f);
        const meta = readMeta(file);
        if (old(file) || (meta?.project && projectMissing(meta.project))) { try { fs.unlinkSync(file); } catch {} continue; }
        if (!meta || (meta.project && !samePath(meta.project, dir))) continue;
        const prev = byDoc.get(f);
        const refs = [...(prev?.refs || []), `${d}/${f}`];
        byDoc.set(f, { ...(prev && prev.time > meta.time ? prev : { ...meta, ref: `${d}/${f}` }), refs });
      }
      removeIfEmpty(d);
    }
    return [...byDoc.values()].sort((a, b) => a.time - b.time);
  });

  ipcMain.handle('recovery:text', (_e, ref) => (typeof ref === 'string' && REF.test(ref) ? readText(path.join(root, ref)) : null));

  ipcMain.handle('recovery:consume', (_e, refs) => {
    const dirs = new Set();
    for (const ref of Array.isArray(refs) ? refs : []) {
      if (typeof ref !== 'string' || !REF.test(ref) || ref.startsWith(`${session}/`)) continue;
      try { fs.unlinkSync(path.join(root, ref)); } catch {}
      dirs.add(ref.split('/')[0]);
    }
    for (const d of dirs) removeIfEmpty(d);
  });

  app.on('will-quit', () => {
    quitting = true;
    clearInterval(tick);
    if (!kept.size) { fs.rmSync(own, { recursive: true, force: true }); return; }
    for (const f of list(own)) if (!kept.has(f)) remove(f);
  });
}

module.exports = { register };
