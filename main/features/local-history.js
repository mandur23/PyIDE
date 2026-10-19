// Local History, like PyCharm's: revisions of project files kept independently of Git. A save in the IDE, a change
// made outside it (seen by a watcher while the project is open, or by comparing sizes and times when it opens) and
// a labeled checkpoint each add a revision. Contents are stored once per hash, gzipped, under
// <userData>/local-history/<project id>/blobs; index.json lists every file's revisions and the labels.
//
// A file record is {p: path relative to the root, revs: [{t, h, k, l?}], m, s, d}: m/s/d are the mtime, size and hash
// last seen on disk. A revision is a time, a content hash (null once deleted), a kind (initial, save, external,
// create, delete, revert, checkpoint) and, for checkpoints, the label. Revisions older than the age limit expire,
// and the oldest go first when the store outgrows its size limit, but the latest revision of a file is always kept,
// so a deleted file can be recovered however long it stayed unchanged.
const fs = require('fs');
const fsp = fs.promises;
const path = require('path');
const crypto = require('crypto');
const zlib = require('zlib');
const textCodec = require('../text-codec');

const IGNORED = new Set(['.git', '__pycache__', 'node_modules', '.idea', '.mypy_cache', '.pytest_cache', '.ruff_cache', '.venv', 'venv', 'env']);
const MAX_FILE_BYTES = 1024 * 1024;
const MAX_FILES = 20000;
const DAY = 86400000;
const DEFAULT_LIMITS = { days: 5, maxMB: 200 };

const sha1 = (buf) => crypto.createHash('sha1').update(buf).digest('hex');

// onChange: called (at most every 200 ms) after revisions or labels were added.
function createStore(dir, root, limits, onChange) {
  const indexFile = path.join(dir, 'index.json');
  const blobDir = path.join(dir, 'blobs');
  let index;
  try { index = JSON.parse(fs.readFileSync(indexFile, 'utf8')); } catch { index = null; }
  if (!index || index.version !== 1) index = { version: 1, root, files: {}, labels: [] };
  let saveTimer = null;
  let added = 0;
  let changeTimer = null;
  const changed = () => { if (!changeTimer) changeTimer = setTimeout(() => { changeTimer = null; onChange(); }, 200); };
  const venvCache = new Map();

  const blobPath = (h) => path.join(blobDir, h.slice(0, 2), h);
  const relOf = (abs) => {
    const rel = path.relative(root, abs);
    return !rel || rel.startsWith('..') || path.isAbsolute(rel) ? null : rel;
  };
  const keyOf = (rel) => rel.toLowerCase();

  // Folders that never belong to the project's own history: tool caches, .git and virtual environments.
  function ignored(rel) {
    const parts = rel.split(path.sep);
    let dirPath = root;
    for (const part of parts.slice(0, -1)) {
      if (IGNORED.has(part)) return true;
      dirPath = path.join(dirPath, part);
      const k = dirPath.toLowerCase();
      if (!venvCache.has(k)) venvCache.set(k, fs.existsSync(path.join(dirPath, 'pyvenv.cfg')));
      if (venvCache.get(k)) return true;
    }
    return IGNORED.has(parts[parts.length - 1]);
  }

  function flush() {
    clearTimeout(saveTimer);
    saveTimer = null;
    fs.mkdirSync(dir, { recursive: true });
    fs.writeFileSync(`${indexFile}.tmp`, JSON.stringify(index));
    fs.renameSync(`${indexFile}.tmp`, indexFile);
  }
  const scheduleSave = () => { if (!saveTimer) saveTimer = setTimeout(flush, 1000); };

  function storeBlob(buf) {
    const h = sha1(buf);
    const p = blobPath(h);
    if (!fs.existsSync(p)) {
      fs.mkdirSync(path.dirname(p), { recursive: true });
      fs.writeFileSync(`${p}.tmp`, zlib.gzipSync(buf));
      fs.renameSync(`${p}.tmp`, p);
    }
    return h;
  }
  const readBlob = (h) => zlib.gunzipSync(fs.readFileSync(blobPath(h)));

  function addRevision(rec, rev) {
    const last = rec.revs[rec.revs.length - 1];
    if (last && last.h === rev.h) return false;
    rec.revs.push(rev);
    if (++added % 200 === 0) prune();
    scheduleSave();
    changed();
    return true;
  }

  function recordFor(rel) {
    const k = keyOf(rel);
    if (!index.files[k]) index.files[k] = { p: rel, revs: [] };
    return index.files[k];
  }

  // What is on disk now for `rel`: a revision when the content differs from the last one, `kind` saying why.
  function observeFile(rel, stat, buf, kind) {
    const rec = recordFor(rel);
    if (rec.m !== undefined && (stat.mtimeMs < rec.m || (stat.mtimeMs === rec.m && stat.size === rec.s))) return false;
    const h = storeBlob(buf);
    Object.assign(rec, { m: stat.mtimeMs, s: stat.size, d: h });
    return addRevision(rec, { t: Date.now(), h, k: kind });
  }

  function observeDeleted(rel) {
    const rec = index.files[keyOf(rel)];
    if (!rec || rec.d == null) return false;
    Object.assign(rec, { m: undefined, s: undefined, d: null });
    return addRevision(rec, { t: Date.now(), h: null, k: 'delete' });
  }

  const tooBig = (stat) => stat.size > MAX_FILE_BYTES;

  async function readCandidate(abs) {
    let stat;
    try { stat = await fsp.stat(abs); } catch { return null; }
    if (!stat.isFile() || tooBig(stat)) return { stat, skip: true };
    let buf;
    try { buf = await fsp.readFile(abs); } catch { return null; }
    return textCodec.looksBinary(buf) ? { stat, skip: true } : { stat, buf };
  }

  // A file on disk now: compared by size and time first, so unchanged files are not read again.
  const unchanged = (rec, stat) => rec && rec.m === stat.mtimeMs && rec.s === stat.size;

  async function check(rel) {
    const abs = path.join(root, rel);
    let stat;
    try { stat = await fsp.stat(abs); } catch { return observeDeleted(rel); }
    if (stat.isDirectory()) return scanDir(abs, false);
    const rec = index.files[keyOf(rel)];
    if (unchanged(rec, stat)) return false;
    const c = await readCandidate(abs);
    if (!c || c.skip) return false;
    return observeFile(rel, c.stat, c.buf, rec ? 'external' : 'create');
  }

  // opening: the scan when the project opens, where unknown files are the initial content rather than new files.
  async function scanDir(absDir, opening) {
    const seen = new Set();
    let count = 0;
    const walk = async (d) => {
      let entries = [];
      try { entries = await fsp.readdir(d, { withFileTypes: true }); } catch { return; }
      for (const e of entries) {
        if (count >= MAX_FILES) return;
        const abs = path.join(d, e.name);
        const rel = relOf(abs);
        if (!rel || ignored(rel)) continue;
        if (e.isDirectory()) {
          if (!ignored(path.join(rel, 'x'))) await walk(abs);
        } else if (e.isFile()) {
          count++;
          seen.add(keyOf(rel));
          const rec = index.files[keyOf(rel)];
          let stat;
          try { stat = await fsp.stat(abs); } catch { continue; }
          if (unchanged(rec, stat)) continue;
          const c = await readCandidate(abs);
          if (c && !c.skip) observeFile(rel, c.stat, c.buf, rec ? 'external' : opening ? 'initial' : 'create');
        }
      }
    };
    await walk(absDir);
    // Files the index knows under this folder that are gone now (unless the walk stopped at the file limit).
    if (count < MAX_FILES) {
      const prefix = relOf(absDir);
      for (const [k, rec] of Object.entries(index.files)) {
        if (rec.d == null || seen.has(k) || (prefix && !k.startsWith(`${keyOf(prefix)}${path.sep}`))) continue;
        if (!fs.existsSync(path.join(root, rec.p))) observeDeleted(rec.p);
      }
    }
    return true;
  }

  // ---------- watcher ----------
  let watcher = null;
  const pending = new Set();
  let watchTimer = null;
  let draining = Promise.resolve();
  let closed = false;
  // A burst of changes (git writing .git) can overflow the Windows change buffer: the watcher then reports a change
  // without a name and goes quiet. That restarts it and rescans the project ('' is the root).
  function startWatching() {
    if (closed) return;
    try {
      watcher = fs.watch(root, { recursive: true }, (_event, name) => {
        if (name && ignored(name)) return;
        if (!name) restartWatching();
        pending.add(name || '');
        clearTimeout(watchTimer);
        watchTimer = setTimeout(() => {
          const names = pending.has('') ? [''] : [...pending];
          pending.clear();
          draining = draining.then(async () => {
            for (const n of names) {
              try { await check(n); } catch (err) { console.error('local history: cannot check', n, err); }
            }
          });
        }, 300);
      });
      watcher.on('error', restartWatching);
    } catch { watcher = null; }
  }
  function restartWatching() {
    const old = watcher;
    watcher = null;
    setImmediate(() => { old?.close(); startWatching(); });
  }

  // ---------- limits ----------
  function prune() {
    const cutoff = Date.now() - limits.days * DAY;
    for (const [k, rec] of Object.entries(index.files)) {
      const last = rec.revs[rec.revs.length - 1];
      rec.revs = rec.revs.filter((r, i) => r.t >= cutoff || (i === rec.revs.length - 1 && rec.d != null) || (r === rec.revs[rec.revs.length - 2] && last.h === null && last.t >= cutoff));
      if (!rec.revs.length && rec.d == null) delete index.files[k];
    }
    index.labels = index.labels.filter((l) => l.t >= cutoff);
    // Over the size limit: drop the oldest revisions that are not a file's latest.
    const sizes = new Map();
    const blobSize = (h) => {
      if (!sizes.has(h)) { try { sizes.set(h, fs.statSync(blobPath(h)).size); } catch { sizes.set(h, 0); } }
      return sizes.get(h);
    };
    const refs = new Map();
    for (const rec of Object.values(index.files)) for (const r of rec.revs) if (r.h) refs.set(r.h, (refs.get(r.h) || 0) + 1);
    let total = [...refs.keys()].reduce((n, h) => n + blobSize(h), 0);
    const max = limits.maxMB * 1024 * 1024;
    if (total > max) {
      const candidates = Object.values(index.files).flatMap((rec) => rec.revs.slice(0, -1).map((r) => ({ rec, r }))).sort((a, b) => a.r.t - b.r.t);
      for (const { rec, r } of candidates) {
        if (total <= max) break;
        rec.revs.splice(rec.revs.indexOf(r), 1);
        if (r.h && refs.set(r.h, refs.get(r.h) - 1).get(r.h) === 0) { total -= blobSize(r.h); refs.delete(r.h); }
      }
    }
    // Contents no revision refers to any more.
    for (const sub of fs.existsSync(blobDir) ? fs.readdirSync(blobDir) : []) {
      for (const h of fs.readdirSync(path.join(blobDir, sub))) {
        if (!refs.has(h)) { try { fs.unlinkSync(path.join(blobDir, sub, h)); } catch {} }
      }
    }
    scheduleSave();
  }

  // ---------- API ----------
  let scanned = null;
  return {
    root,
    open() {
      startWatching();
      scanned = scanDir(root, true).then(() => draining).then(() => prune()).catch((err) => console.error('local history scan failed', err));
      return scanned;
    },
    close() {
      closed = true;
      watcher?.close();
      clearTimeout(watchTimer);
      clearTimeout(changeTimer);
      flush();
    },
    flush,
    setLimits(l) { limits = l; },
    async record(abs, kind) {
      await scanned;
      const rel = relOf(abs);
      if (!rel || ignored(rel)) return false;
      let stat;
      try { stat = fs.statSync(abs); } catch { return observeDeleted(rel); }
      if (!stat.isFile() || tooBig(stat)) return false;
      const buf = fs.readFileSync(abs);
      if (textCodec.looksBinary(buf)) return false;
      const rec = index.files[keyOf(rel)];
      // The watcher may have reported this write a moment earlier; the save is the better name for it.
      const last = rec?.revs[rec.revs.length - 1];
      if (last && last.k === 'external' && last.h === sha1(buf) && Date.now() - last.t < 5000) { last.k = kind; scheduleSave(); changed(); return true; }
      if (rec) rec.m = undefined;
      return observeFile(rel, stat, buf, kind);
    },
    // A labeled point in time, plus the unsaved text of open documents ({path, text, encoding}) where it differs.
    async checkpoint(label, user, docs) {
      await scanned;
      const t = Date.now();
      for (const doc of docs) {
        const rel = relOf(doc.path);
        if (!rel || ignored(rel)) continue;
        const buf = textCodec.encode(doc.text, doc.encoding);
        addRevision(recordFor(rel), { t, h: storeBlob(buf), k: 'checkpoint', l: label, ...(user ? { u: 1 } : {}) });
      }
      index.labels.push({ t, l: label, ...(user ? { u: 1 } : {}) });
      scheduleSave();
      changed();
      return t;
    },
    // Revisions of a file, or of every file under a folder, newest first, with the labels since the oldest.
    async list(abs, isDir) {
      await scanned;
      await draining;
      const rel = relOf(abs);
      const prefix = rel ? `${keyOf(rel)}${path.sep}` : '';
      const recs = Object.entries(index.files).filter(([k]) => (isDir ? !rel || k.startsWith(prefix) : k === keyOf(rel || '')));
      const revisions = recs.flatMap(([, rec]) => rec.revs.map((r) => ({ path: path.join(root, rec.p), ...r })))
        .sort((a, b) => b.t - a.t);
      const oldest = revisions.length ? revisions[revisions.length - 1].t : Infinity;
      return { revisions, labels: index.labels.filter((l) => l.t >= oldest).sort((a, b) => b.t - a.t) };
    },
    content(h) {
      const buf = readBlob(h);
      if (textCodec.looksBinary(buf)) return { binary: true };
      const encoding = textCodec.detect(buf);
      return { text: textCodec.decode(buf, encoding), encoding };
    },
    // Writes a revision's bytes back (recreating a deleted file and its folders).
    async restore(abs, h) {
      await draining;
      const rel = relOf(abs);
      if (!rel) throw new Error('outside the project');
      fs.mkdirSync(path.dirname(abs), { recursive: true });
      fs.writeFileSync(abs, readBlob(h));
      const rec = recordFor(rel);
      rec.m = undefined;
      observeFile(rel, fs.statSync(abs), readBlob(h), 'revert');
      return true;
    },
    // Moves history along with a renamed file or folder.
    rename(fromAbs, toAbs) {
      const from = relOf(fromAbs);
      const to = relOf(toAbs);
      if (!from || !to) return;
      const fk = keyOf(from);
      for (const [k, rec] of Object.entries(index.files)) {
        if (k !== fk && !k.startsWith(`${fk}${path.sep}`)) continue;
        const rel = to + rec.p.slice(from.length);
        delete index.files[k];
        const target = index.files[keyOf(rel)];
        index.files[keyOf(rel)] = target
          ? { ...rec, p: rel, revs: [...target.revs, ...rec.revs].sort((a, b) => a.t - b.t) }
          : { ...rec, p: rel };
      }
      scheduleSave();
    },
  };
}

function register(ctx) {
  const { ipcMain, app } = ctx;
  const base = path.join(app.getPath('userData'), 'local-history');
  const stores = new Map(); // lower-cased root -> store
  const storeDir = (root) => path.join(base, sha1(root.toLowerCase()).slice(0, 16));
  const storeOf = (root) => {
    const s = root && stores.get(root.toLowerCase());
    if (!s) throw new Error('Local History is not open for this project');
    return s;
  };

  ipcMain.handle('localHistory:open', (_e, root, limits) => {
    for (const [k, s] of stores) if (k !== root.toLowerCase()) { s.close(); stores.delete(k); }
    let s = stores.get(root.toLowerCase());
    if (s) { s.setLimits({ ...DEFAULT_LIMITS, ...limits }); return true; }
    s = createStore(storeDir(root), root, { ...DEFAULT_LIMITS, ...limits }, () => ctx.send('localHistory:changed', { root }));
    stores.set(root.toLowerCase(), s);
    return s.open().then(() => true);
  });
  ipcMain.handle('localHistory:close', (_e, root) => {
    const s = root && stores.get(root.toLowerCase());
    if (s) { s.close(); stores.delete(root.toLowerCase()); }
  });
  ipcMain.handle('localHistory:limits', (_e, root, limits) => storeOf(root).setLimits({ ...DEFAULT_LIMITS, ...limits }));
  ipcMain.handle('localHistory:record', (_e, root, abs, kind) => storeOf(root).record(abs, kind));
  ipcMain.handle('localHistory:checkpoint', (_e, root, label, user, docs) => storeOf(root).checkpoint(label, user, docs || []));
  ipcMain.handle('localHistory:list', (_e, root, abs, isDir) => storeOf(root).list(abs, isDir));
  ipcMain.handle('localHistory:content', (_e, root, h) => storeOf(root).content(h));
  ipcMain.handle('localHistory:restore', (_e, root, abs, h) => storeOf(root).restore(abs, h));
  ipcMain.handle('localHistory:rename', (_e, root, from, to) => storeOf(root).rename(from, to));
  app.on('before-quit', () => { for (const s of stores.values()) s.close(); });
}

module.exports = { register };
