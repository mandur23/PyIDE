// Local History, like PyCharm's: revisions of project files kept independently of Git. As in PyCharm, a file is
// recorded from the first time it is opened in the editor or changes: a save in the IDE, a change made elsewhere
// (seen by a watcher while the project is open, or by comparing sizes and times of recorded files when it opens) and
// a labeled checkpoint each add a revision. Contents are stored once per hash, gzipped, under
// <userData>/local-history/<project id>/blobs; index.json lists every recorded file's revisions and the labels.
//
// A file record is {p: path relative to the root, revs: [{t, h, k, l?}], m, s, d}: m/s/d are the mtime, size and hash
// last seen on disk. A revision is a time, a content hash (null once deleted), a kind (initial, save, external,
// create, delete, revert, checkpoint) and, for checkpoints, the label. Revisions older than the age limit expire,
// and the oldest go first when the store outgrows its size limit, but the latest revision of a file is always kept,
// so a deleted file can be recovered however long it stayed unchanged.
//
// Reading, hashing and compressing files runs on a worker thread (main/worker-host.js evaluates this file with the
// role checked at the end), so a burst of changes such as a git checkout never stalls the main process.
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const zlib = require('zlib');
const { isMainThread, parentPort, workerData } = require('worker_threads');

const IGNORED = new Set(['.git', '__pycache__', 'node_modules', '.idea', '.mypy_cache', '.pytest_cache', '.ruff_cache', '.venv', 'venv', 'env']);
const MAX_FILE_BYTES = 1024 * 1024;
// Files the history has not seen yet that one burst of outside changes may add; a bigger burst (a branch switch, a
// code generator) records only the files it already knows.
const MAX_NEW = 200;
const DAY = 86400000;
const DEFAULT_LIMITS = { days: 5, maxMB: 200 };
// Blobs younger than this survive garbage collection: a revision may be on its way to the index.
const GC_GRACE_MS = 60000;
// A file or folder created less than this long ago is new; older unrecorded ones were changed.
const NEW_FILE_MS = 10000;

const sha1 = (buf) => crypto.createHash('sha1').update(buf).digest('hex');
const blobPath = (blobDir, h) => path.join(blobDir, h.slice(0, 2), h);
// The same tests as main/text-codec.js (which the worker cannot require: it runs from evaluated text). UTF-16, with or
// without a byte order mark, is full of NUL bytes but is text.
function isUtf16(buf) {
  if ((buf[0] === 0xff && buf[1] === 0xfe) || (buf[0] === 0xfe && buf[1] === 0xff)) return true;
  if (buf.length < 2 || buf.length % 2) return false;
  const n = Math.min(buf.length, 8000);
  let le = 0;
  let be = 0;
  for (let i = 0; i < n; i += 2) {
    if (buf[i] === 0 && buf[i + 1] === 0) return false;
    if (buf[i + 1] === 0 && buf[i] >= 9 && buf[i] < 0x7f) le++;
    else if (buf[i] === 0 && buf[i + 1] >= 9 && buf[i + 1] < 0x7f) be++;
  }
  return (le >= n / 6 && be <= le / 20) || (be >= n / 6 && le <= be / 20);
}
function looksBinary(buf) {
  if (isUtf16(buf)) return false;
  const n = Math.min(buf.length, 8000);
  for (let i = 0; i < n; i++) if (buf[i] === 0) return true;
  return false;
}

// A blob stored again is touched: another PyIDE instance collecting garbage spares blobs younger than GC_GRACE_MS, and
// this one may be about to refer to an old blob its index had dropped.
function storeBlob(blobDir, buf) {
  const h = sha1(buf);
  const p = blobPath(blobDir, h);
  if (fs.existsSync(p)) {
    try { const now = new Date(); fs.utimesSync(p, now, now); } catch {}
  } else {
    fs.mkdirSync(path.dirname(p), { recursive: true });
    fs.writeFileSync(`${p}.tmp`, zlib.gzipSync(buf));
    fs.renameSync(`${p}.tmp`, p);
  }
  return h;
}

// Folders that never belong to the project's own history: tool caches, .git and virtual environments.
function createIgnore(root) {
  const venvCache = new Map();
  return (rel) => {
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
  };
}

// ---------- worker side ----------
const DISK = {
  // items [{rel, m?, s?}]: the stat last seen, if any; an equal stat answers 'same' without reading the file.
  // -> [{rel, state: 'file', m, s, h, b} | {rel, state: 'dir', b} | {rel, state: 'same' | 'missing' | 'skip'}]
  // b: the birth time.
  ingest(root, blobDir, items) {
    return items.map(({ rel, m, s }) => {
      const abs = path.join(root, rel);
      let st;
      try { st = fs.statSync(abs); } catch { return { rel, state: 'missing' }; }
      if (st.isDirectory()) return { rel, state: 'dir', b: st.birthtimeMs };
      if (!st.isFile() || st.size > MAX_FILE_BYTES) return { rel, state: 'skip' };
      if (st.mtimeMs === m && st.size === s) return { rel, state: 'same' };
      let buf;
      try { buf = fs.readFileSync(abs); } catch { return { rel, state: 'skip' }; }
      if (looksBinary(buf)) return { rel, state: 'skip' };
      return { rel, state: 'file', m: st.mtimeMs, s: st.size, h: storeBlob(blobDir, buf), b: st.birthtimeMs };
    });
  },
  // Files under a folder (relative to the root), at most `limit`.
  walk(root, rel, limit) {
    const ignored = createIgnore(root);
    const out = [];
    const walk = (dirRel) => {
      let entries = [];
      try { entries = fs.readdirSync(path.join(root, dirRel), { withFileTypes: true }); } catch { return; }
      for (const e of entries) {
        if (out.length >= limit) return;
        const r = path.join(dirRel, e.name);
        if (e.isDirectory() ? ignored(path.join(r, 'x')) : ignored(r)) continue;
        if (e.isDirectory()) walk(r); else if (e.isFile()) out.push(r);
      }
    };
    walk(rel);
    return out;
  },
  // -> {hash: compressed size} for the given blobs.
  sizes(blobDir, hashes) {
    const out = {};
    for (const h of hashes) { try { out[h] = fs.statSync(blobPath(blobDir, h)).size; } catch { out[h] = 0; } }
    return out;
  },
  // Deletes blobs no revision refers to (unless just written).
  gc(blobDir, keep) {
    const live = new Set(keep);
    const now = Date.now();
    for (const sub of fs.existsSync(blobDir) ? fs.readdirSync(blobDir) : []) {
      for (const name of fs.readdirSync(path.join(blobDir, sub))) {
        const p = path.join(blobDir, sub, name);
        if (live.has(name)) continue;
        try { if (now - fs.statSync(p).mtimeMs > GC_GRACE_MS) fs.unlinkSync(p); } catch {}
      }
    }
    return true;
  },
};
if (!isMainThread && workerData?.role === 'pyide-local-history') {
  parentPort.on('message', ({ id, op, args }) => {
    try { parentPort.postMessage({ id, result: DISK[op](...args) }); } catch (e) { parentPort.postMessage({ id, error: e.message }); }
  });
}

// ---------- main side ----------
const disk = isMainThread ? require('../worker-host').fileWorker(__filename, 'pyide-local-history') : null;
const textCodec = isMainThread ? require('../text-codec') : null;

// An index of another shape (another version, a hand edit) counts as none, as an unreadable one does.
function parseIndex(text) {
  let index = null;
  try { index = JSON.parse(text); } catch {}
  const ok = index && index.version === 1 && index.files && typeof index.files === 'object' && !Array.isArray(index.files) && Array.isArray(index.labels);
  return ok ? index : null;
}

const revId = (r) => `${r.t}|${r.h}`;
const labelId = (l) => `${l.t}|${l.l}`;

// onChange: called (at most every 200 ms) after revisions or labels were added. isEnvironmentError: whether an error is
// the computer's (a folder that cannot be written, a full disk; main/diagnostics). onWriteError(message): called once
// when a revision or the index cannot be written.
function createStore(dir, root, limits, onChange, { isEnvironmentError = () => false, onWriteError = () => {} } = {}) {
  const indexFile = path.join(dir, 'index.json');
  const blobDir = path.join(dir, 'blobs');
  let index;
  try { index = parseIndex(fs.readFileSync(indexFile, 'utf8')); } catch { index = null; }
  index ||= { version: 1, root, files: {}, labels: [] };
  let saveTimer = null;
  let added = 0;
  let changeTimer = null;
  const changed = () => { if (!changeTimer) changeTimer = setTimeout(() => { changeTimer = null; onChange(); }, 200); };
  // Every operation on the index runs in turn: a checkpoint right after a save must come after the save's revision,
  // although reading the saved file takes a round trip to the worker.
  let queue = Promise.resolve();
  const serial = (fn) => {
    const run = queue.then(fn);
    queue = run.catch((err) => console.error('local history:', err));
    return run;
  };
  // A revision that cannot be stored is skipped, and the user is told once.
  let told = false;
  function writeFailed(err) {
    if (!isEnvironmentError(err)) return console.error('local history: could not save the index:', err);
    console.warn(`local history: cannot write ${dir}: ${err?.message || err}`);
    if (told) return;
    told = true;
    onWriteError(String(err?.message || err));
  }
  const recording = (fn) => serial(async () => {
    try { return await fn(); } catch (err) {
      if (!isEnvironmentError(err)) throw err;
      writeFailed(err);
      return false;
    }
  });
  const ignored = createIgnore(root);

  const relOf = (abs) => {
    const rel = path.relative(root, abs);
    return !rel || rel.startsWith('..') || path.isAbsolute(rel) ? null : rel;
  };
  const keyOf = (rel) => rel.toLowerCase();
  const tracked = (rel) => index.files[keyOf(rel)];
  const trackedUnder = (rel) => {
    const prefix = rel ? `${keyOf(rel)}${path.sep}` : '';
    return Object.entries(index.files).filter(([k]) => k.startsWith(prefix)).map(([, rec]) => rec);
  };
  // What the worker needs to tell an unchanged recorded file from a changed one.
  const item = (rel) => { const rec = tracked(rel); return { rel, m: rec?.m, s: rec?.s }; };

  // ---------- several instances ----------
  // PyIDE instances sharing the user data (one per project, or two on one project) share index.json. Every write first
  // merges the index on disk into this one, so neither instance drops what the other recorded, and garbage collection
  // keeps the blobs the other's revisions use. What this store removed itself (expired revisions, a renamed file's old
  // entry) is remembered, so it does not come back from the disk. A revision only this store still lists whose blob is
  // gone was collected by the other instance and is dropped.
  const removed = new Set(); // `${key}\n${revId}`
  const removedLabels = new Set();
  const forget = (k, revs) => { for (const r of revs) removed.add(`${k}\n${revId(r)}`); };
  const hasBlob = (h) => h == null || fs.existsSync(blobPath(blobDir, h));

  // Merges in place: an operation waiting on the worker may hold a record of this index.
  function merge(disk) {
    if (!disk) return;
    for (const [k, theirs] of Object.entries(disk.files)) {
      if (!theirs || !Array.isArray(theirs.revs) || typeof theirs.p !== 'string') continue;
      const revs = theirs.revs.filter((r) => r && Number.isFinite(r.t) && !removed.has(`${k}\n${revId(r)}`));
      const mine = index.files[k];
      if (!mine) {
        if (revs.length) index.files[k] = { ...theirs, revs };
        continue;
      }
      const onDisk = new Set(revs.map(revId));
      const own = mine.revs.filter((r) => onDisk.has(revId(r)) || hasBlob(r.h));
      const ids = new Set(own.map(revId));
      const newer = (revs.at(-1)?.t ?? -Infinity) > (own.at(-1)?.t ?? -Infinity);
      // Both instances may have recorded one change (a save in one, seen by the other's watcher): as addRevision does,
      // a revision with the content of the one before it is left out.
      const all = [...own, ...revs.filter((r) => !ids.has(revId(r)))].sort((a, b) => a.t - b.t);
      mine.revs = all.filter((r, i) => i === 0 || r.h !== all[i - 1].h);
      if (newer) Object.assign(mine, { m: theirs.m, s: theirs.s, d: theirs.d });
    }
    const labels = new Set(index.labels.map(labelId));
    for (const l of disk.labels) if (l && !labels.has(labelId(l)) && !removedLabels.has(labelId(l))) index.labels.push(l);
    index.labels.sort((a, b) => a.t - b.t);
  }
  const readDisk = () => fs.promises.readFile(indexFile, 'utf8').then(parseIndex, () => null);

  // At close (and quit) the index is written synchronously, so it is on disk before the store goes away.
  function flushSync() {
    clearTimeout(saveTimer);
    saveTimer = null;
    try {
      let disk = null;
      try { disk = parseIndex(fs.readFileSync(indexFile, 'utf8')); } catch {}
      merge(disk);
      fs.mkdirSync(dir, { recursive: true });
      fs.writeFileSync(`${indexFile}.tmp`, JSON.stringify(index));
      fs.renameSync(`${indexFile}.tmp`, indexFile);
    } catch (err) {
      writeFailed(err);
    }
  }
  // While the project is open the index (which can be megabytes) is written off the main thread, one write at a time,
  // to a temporary file of its own that replaces index.json at the end. A write still running when the store closes
  // is dropped: close() has written the newer index by then. The merge runs between the index's operations.
  let writing = null;
  let writes = 0;
  function flush() {
    saveTimer = null;
    if (writing) { writing.then(scheduleSave); return; }
    const tmp = `${indexFile}.${process.pid}-${++writes}.tmp`;
    writing = serial(async () => { merge(await readDisk()); return JSON.stringify(index); })
      .then(async (data) => {
        await fs.promises.mkdir(dir, { recursive: true });
        await fs.promises.writeFile(tmp, data);
        if (closed) fs.rmSync(tmp, { force: true }); else fs.renameSync(tmp, indexFile);
      })
      .catch((err) => { fs.promises.rm(tmp, { force: true }).catch(() => {}); writeFailed(err); })
      .finally(() => { writing = null; });
  }
  // A closed store wrote its index at close(); work still queued then must not write a stale index over the one a
  // store opened again for the same project (Close Project and reopen) keeps.
  const scheduleSave = () => { if (!saveTimer && !closed) saveTimer = setTimeout(flush, 1000); };
  const readBlob = (h) => zlib.gunzipSync(fs.readFileSync(blobPath(blobDir, h)));

  function addRevision(rec, rev) {
    const last = rec.revs[rec.revs.length - 1];
    if (last && last.h === rev.h) return false;
    rec.revs.push(rev);
    if (++added % 200 === 0) serial(prune);
    scheduleSave();
    changed();
    return true;
  }

  function recordFor(rel) {
    const k = keyOf(rel);
    if (!index.files[k]) index.files[k] = { p: rel, revs: [] };
    return index.files[k];
  }

  // Applies what the worker found for a file: a revision of `kind` when the content changed.
  function apply(r, kind) {
    if (r.state === 'missing') return observeDeleted(r.rel);
    if (r.state !== 'file') return false;
    const rec = recordFor(r.rel);
    // A result older than what is already known (a save recorded meanwhile) is stale.
    if (rec.m !== undefined && (r.m < rec.m || (r.m === rec.m && r.s === rec.s))) return false;
    Object.assign(rec, { m: r.m, s: r.s, d: r.h });
    return addRevision(rec, { t: Date.now(), h: r.h, k: kind });
  }

  function observeDeleted(rel) {
    const rec = tracked(rel);
    if (!rec || rec.d == null) return false;
    Object.assign(rec, { m: undefined, s: undefined, d: null });
    return addRevision(rec, { t: Date.now(), h: null, k: 'delete' });
  }

  // Why a file changed: it is new, or it was changed (a file seen for the first time counts as new only if just born).
  function kindOf(r) {
    const rec = tracked(r.rel);
    if (rec) return rec.d == null ? 'create' : 'external';
    return Date.now() - r.b < NEW_FILE_MS ? 'create' : 'external';
  }

  // Recorded files under `rel` ('' = the whole project), plus the files of a folder that just appeared (up to MAX_NEW).
  async function checkFolder(rel, appeared = false) {
    const items = trackedUnder(rel).map((rec) => item(rec.p));
    const known = new Set(items.map((i) => keyOf(i.rel)));
    if (appeared) {
      const files = await disk('walk', root, rel, MAX_NEW + 1);
      if (files.length <= MAX_NEW) for (const r of files) if (!known.has(keyOf(r))) items.push({ rel: r });
    }
    if (!items.length) return;
    for (const r of await disk('ingest', root, blobDir, items)) apply(r, kindOf(r));
  }

  // ---------- watcher ----------
  let watcher = null;
  let closed = false;
  const pending = new Set();
  let lost = false; // the watcher dropped events since the last batch
  let watchTimer = null;

  async function processBatch(changed, dropped) {
    if (dropped) return checkFolder('');
    const names = changed.filter((n) => !ignored(n));
    const unknown = names.filter((n) => !tracked(n)).length;
    const take = unknown > MAX_NEW ? names.filter((n) => tracked(n)) : names;
    for (const r of await disk('ingest', root, blobDir, take.map(item))) {
      if (r.state === 'dir' || (r.state === 'missing' && !tracked(r.rel))) {
        // A folder: its recorded files (gone too if it was deleted), and its files if it was just created.
        await checkFolder(r.rel, r.state === 'dir' && Date.now() - r.b < NEW_FILE_MS);
      } else {
        apply(r, kindOf(r));
      }
    }
  }

  // Events arrive by the thousand during a checkout, so the callback only collects names; a batch is handled once
  // nothing has arrived for 300 ms.
  let lastEvent = 0;
  function takeBatch() {
    const quiet = Date.now() - lastEvent;
    if (quiet < 300) { watchTimer = setTimeout(takeBatch, 300 - quiet); return; }
    watchTimer = null;
    const names = [...pending];
    const dropped = lost;
    pending.clear();
    lost = false;
    serial(() => processBatch(names, dropped));
  }

  // A burst of changes (git writing .git) can overflow the Windows change buffer: the watcher then reports a change
  // without a name and goes quiet. That restarts it and rechecks every recorded file.
  function startWatching() {
    if (closed) return;
    try {
      watcher = fs.watch(root, { recursive: true }, (_event, name) => {
        if (name) pending.add(name);
        else { lost = true; restartWatching(); }
        lastEvent = Date.now();
        if (!watchTimer) watchTimer = setTimeout(takeBatch, 300);
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
  async function prune() {
    merge(await readDisk());
    const cutoff = Date.now() - limits.days * DAY;
    for (const [k, rec] of Object.entries(index.files)) {
      const n = rec.revs.length;
      const last = rec.revs[n - 1];
      // Kept: recent revisions, a file's latest, and the content just before a recent deletion.
      const keep = rec.revs.filter((r, i) => r.t >= cutoff || (i === n - 1 && rec.d != null) || (i === n - 2 && last.h === null && last.t >= cutoff));
      const kept = new Set(keep);
      forget(k, rec.revs.filter((r) => !kept.has(r)));
      rec.revs = keep;
      if (!rec.revs.length && rec.d == null) delete index.files[k];
    }
    for (const l of index.labels) if (l.t < cutoff) removedLabels.add(labelId(l));
    index.labels = index.labels.filter((l) => l.t >= cutoff);
    const refs = new Map();
    for (const rec of Object.values(index.files)) for (const r of rec.revs) if (r.h) refs.set(r.h, (refs.get(r.h) || 0) + 1);
    const sizes = await disk('sizes', blobDir, [...refs.keys()]);
    let total = Object.values(sizes).reduce((a, b) => a + b, 0);
    const max = limits.maxMB * 1024 * 1024;
    if (total > max) {
      // The oldest revisions that are not a file's latest go first.
      const candidates = Object.values(index.files).flatMap((rec) => rec.revs.slice(0, -1).map((r) => ({ rec, r }))).sort((a, b) => a.r.t - b.r.t);
      for (const { rec, r } of candidates) {
        if (total <= max) break;
        rec.revs.splice(rec.revs.indexOf(r), 1);
        forget(keyOf(rec.p), [r]);
        if (r.h && refs.set(r.h, refs.get(r.h) - 1).get(r.h) === 0) { total -= sizes[r.h] || 0; refs.delete(r.h); }
      }
    }
    await disk('gc', blobDir, [...refs.keys()]);
    scheduleSave();
  }

  // The text the editor loaded is the initial revision; a save may already have changed the file on disk.
  async function recordOpened(rel, doc) {
    if (!doc) return false;
    const buf = textCodec.encode(doc.text, doc.encoding);
    if (buf.length > MAX_FILE_BYTES) return false;
    const h = storeBlob(blobDir, buf);
    const [r] = await disk('ingest', root, blobDir, [{ rel }]);
    if (tracked(rel)) return false;
    const rec = recordFor(rel);
    if (r.state === 'file' && r.h === h) Object.assign(rec, { m: r.m, s: r.s, d: h });
    return addRevision(rec, { t: Date.now(), h, k: 'initial' });
  }

  // ---------- API ----------
  return {
    root,
    // Watches the project and rechecks the files recorded before (changes made while the IDE was closed).
    open() {
      startWatching();
      return recording(async () => { await checkFolder(''); await prune(); return true; });
    },
    close() {
      closed = true;
      watcher?.close();
      clearTimeout(watchTimer);
      clearTimeout(changeTimer);
      flushSync();
    },
    setLimits(l) { limits = l; },
    // kind: 'save' or 'revert' after the IDE wrote the file; 'opened' when the editor opened it, with the text it
    // loaded ({text, encoding}): the first revision of a file seen for the first time, or a change the watcher has
    // not reported yet.
    record: (abs, kind, doc) => recording(async () => {
      const rel = relOf(abs);
      if (!rel || ignored(rel)) return false;
      const rec = tracked(rel);
      if (kind === 'opened' && !rec) return recordOpened(rel, doc);
      const [r] = await disk('ingest', root, blobDir, [kind === 'opened' ? item(rel) : { rel }]);
      if (kind === 'opened') return apply(r, rec.d == null ? 'create' : 'external');
      if (r.state !== 'file') return r.state === 'missing' ? observeDeleted(rel) : false;
      // The watcher may have reported this write a moment earlier; the save is the better name for it.
      const last = rec?.revs[rec.revs.length - 1];
      if (last && last.k === 'external' && last.h === r.h && Date.now() - last.t < 5000) { last.k = kind; scheduleSave(); changed(); return true; }
      if (rec) rec.m = undefined;
      return apply(r, kind);
    }),
    // A labeled point in time, plus the unsaved text of open documents ({path, text, encoding}) where it differs.
    checkpoint: (label, user, docs) => recording(() => {
      const t = Date.now();
      for (const doc of docs) {
        const rel = relOf(doc.path);
        if (!rel || ignored(rel)) continue;
        const h = storeBlob(blobDir, textCodec.encode(doc.text, doc.encoding));
        addRevision(recordFor(rel), { t, h, k: 'checkpoint', l: label, ...(user ? { u: 1 } : {}) });
      }
      index.labels.push({ t, l: label, ...(user ? { u: 1 } : {}) });
      scheduleSave();
      changed();
      return t;
    }),
    // Revisions of a file, or of every file under a folder, newest first, with the labels since the oldest.
    list: (abs, isDir) => serial(() => {
      const rel = relOf(abs);
      const recs = isDir ? trackedUnder(rel || '') : [tracked(rel || '')].filter(Boolean);
      const revisions = recs.flatMap((rec) => rec.revs.map((r) => ({ path: path.join(root, rec.p), ...r }))).sort((a, b) => b.t - a.t);
      const oldest = revisions.length ? revisions[revisions.length - 1].t : Infinity;
      return { revisions, labels: index.labels.filter((l) => l.t >= oldest).sort((a, b) => b.t - a.t) };
    }),
    content(h) {
      const buf = readBlob(h);
      // UTF-16 is full of NUL bytes, so the encoding is detected before the binary check (as text-codec's read does).
      const encoding = textCodec.detect(buf);
      if (!encoding.startsWith('utf-16') && looksBinary(buf)) return { binary: true };
      return { text: textCodec.decode(buf, encoding), encoding };
    },
    // Writes a revision's bytes back (recreating a deleted file and its folders).
    restore: (abs, h) => serial(() => {
      const rel = relOf(abs);
      if (!rel) throw new Error('outside the project');
      fs.mkdirSync(path.dirname(abs), { recursive: true });
      fs.writeFileSync(abs, readBlob(h));
      const st = fs.statSync(abs);
      const rec = recordFor(rel);
      Object.assign(rec, { m: st.mtimeMs, s: st.size, d: h });
      return addRevision(rec, { t: Date.now(), h, k: 'revert' });
    }),
    // Moves history along with a renamed file or folder.
    rename: (fromAbs, toAbs) => serial(() => {
      const from = relOf(fromAbs);
      const to = relOf(toAbs);
      if (!from || !to) return;
      const fk = keyOf(from);
      for (const [k, rec] of Object.entries(index.files)) {
        if (k !== fk && !k.startsWith(`${fk}${path.sep}`)) continue;
        const rel = to + rec.p.slice(from.length);
        forget(k, rec.revs);
        delete index.files[k];
        const target = index.files[keyOf(rel)];
        index.files[keyOf(rel)] = target
          ? { ...rec, p: rel, revs: [...target.revs, ...rec.revs].sort((a, b) => a.t - b.t) }
          : { ...rec, p: rel };
      }
      scheduleSave();
    }),
  };
}

function register(ctx) {
  const { ipcMain, app, diagnostics } = ctx;
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
    const dir = storeDir(root);
    s = createStore(dir, root, { ...DEFAULT_LIMITS, ...limits }, () => ctx.send('localHistory:changed', { root }), {
      isEnvironmentError: (err) => !!diagnostics?.isEnvironmentError(err),
      onWriteError: (error) => ctx.send('localHistory:writeFailed', { root, dir, error }),
    });
    stores.set(root.toLowerCase(), s);
    return s.open().then(() => true);
  });
  ipcMain.handle('localHistory:close', (_e, root) => {
    const s = root && stores.get(root.toLowerCase());
    if (s) { s.close(); stores.delete(root.toLowerCase()); }
  });
  ipcMain.handle('localHistory:limits', (_e, root, limits) => storeOf(root).setLimits({ ...DEFAULT_LIMITS, ...limits }));
  ipcMain.handle('localHistory:record', (_e, root, abs, kind, doc) => storeOf(root).record(abs, kind, doc));
  ipcMain.handle('localHistory:checkpoint', (_e, root, label, user, docs) => storeOf(root).checkpoint(label, user, docs || []));
  ipcMain.handle('localHistory:list', (_e, root, abs, isDir) => storeOf(root).list(abs, isDir));
  ipcMain.handle('localHistory:content', (_e, root, h) => storeOf(root).content(h));
  ipcMain.handle('localHistory:restore', (_e, root, abs, h) => storeOf(root).restore(abs, h));
  ipcMain.handle('localHistory:rename', (_e, root, from, to) => storeOf(root).rename(from, to));
  app.on('before-quit', () => { for (const s of stores.values()) s.close(); });
}

module.exports = { register };
