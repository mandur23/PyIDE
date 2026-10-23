// Crash recovery of unsaved edits (renderer/features/recovery). Each PyIDE process keeps its backups in its own
// session folder, <userData>/backups/<pid>-<start time>/, beside session.json ({pid, beat}, rewritten every minute).
// A clean quit removes the folder. A folder whose process is gone (a crash, a killed process, a power cut) holds the
// backups offered for restore; a live process's folder is never offered, so two PyIDE instances sharing the user data
// leave each other's backups alone.
//
// A backup file is one line of JSON metadata ({path, name, untitled, project, language, encoding, lineSeparator,
// diskHash, asText, time}), a line break, then the document's text, written to a temporary file and renamed over the
// old one. Its name is a hash of the document's identity, so windows editing the same document (the text is shared
// through this process) write one file, which is removed only once no window holds it.
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');

const BEAT_MS = 60000;
// A session.json older than this belongs to a dead process even if the operating system reused its pid.
const STALE_MS = 5 * BEAT_MS;
const REF = /^\d+-\d+\/[0-9a-f]{40}\.backup$/;

const fileOf = (id) => `${crypto.createHash('sha1').update(String(id)).digest('hex')}.backup`;
const samePath = (a, b) => !!a && !!b && path.resolve(a).toLowerCase() === path.resolve(b).toLowerCase();
const list = (dir) => { try { return fs.readdirSync(dir); } catch { return []; } };

function readBackup(file) {
  try {
    const raw = fs.readFileSync(file, 'utf8');
    const nl = raw.indexOf('\n');
    const meta = JSON.parse(raw.slice(0, nl));
    return meta && typeof meta === 'object' ? { ...meta, text: raw.slice(nl + 1) } : null;
  } catch { return null; }
}

function register({ ipcMain, app, getWindow }) {
  const root = path.join(app.getPath('userData'), 'backups');
  const session = `${process.pid}-${Date.now()}`;
  const own = path.join(root, session);
  const holders = new Map(); // backup file name -> Set of webContents ids
  // Backups of a window whose renderer crashed: nobody answered a save prompt for them, so they outlive a clean quit.
  const kept = new Set();
  const watched = new Set();
  let project = null;
  let quitting = false;
  let beat = null;

  const writeSession = () => { try { fs.writeFileSync(path.join(own, 'session.json'), JSON.stringify({ pid: process.pid, beat: Date.now() })); } catch {} };
  function openSession() {
    if (beat) return;
    fs.mkdirSync(own, { recursive: true });
    writeSession();
    beat = setInterval(writeSession, BEAT_MS);
    beat.unref();
  }
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
    if (watched.has(id)) return;
    watched.add(id);
    wc.on('render-process-gone', (_e, details) => { if (details.reason !== 'clean-exit') keepAll(id); });
    wc.once('destroyed', () => { watched.delete(id); releaseAll(id); });
  }

  function alive(dir) {
    let s;
    try { s = JSON.parse(fs.readFileSync(path.join(root, dir, 'session.json'), 'utf8')); } catch { return false; }
    if (!s?.pid || s.pid === process.pid || Date.now() - s.beat > STALE_MS) return false;
    try { process.kill(s.pid, 0); return true; } catch (err) { return err.code === 'EPERM'; }
  }
  const deadSessions = () => list(root).filter((d) => d !== session && /^\d+-\d+$/.test(d) && !alive(d));
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

  // Backups left by dead sessions for `dir` (and those made with no project open), oldest first. A document backed up
  // by several dead sessions is listed once, with its newest text and every file in refs.
  ipcMain.handle('recovery:pending', (_e, dir) => {
    const byDoc = new Map();
    for (const d of deadSessions()) {
      for (const f of list(path.join(root, d)).filter((x) => x.endsWith('.backup'))) {
        const rec = readBackup(path.join(root, d, f));
        if (!rec || (rec.project && !samePath(rec.project, dir))) continue;
        const prev = byDoc.get(f);
        const refs = [...(prev?.refs || []), `${d}/${f}`];
        byDoc.set(f, { ...(prev && prev.time > rec.time ? prev : rec), refs });
      }
      removeIfEmpty(d);
    }
    return [...byDoc.values()].sort((a, b) => a.time - b.time);
  });

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
    clearInterval(beat);
    if (!kept.size) { fs.rmSync(own, { recursive: true, force: true }); return; }
    for (const f of list(own)) if (f !== 'session.json' && !kept.has(f)) remove(f);
  });
}

module.exports = { register };
