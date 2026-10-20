// Semantic code search with Google's EmbeddingGemma 2 (Apache 2.0, google/embeddinggemma-2).
// The model runs in a Python sidecar (main/semantic/embed_server.py) inside the shared AI runtime (main/ai/runtime.js),
// a private venv that reuses the system torch. Project files are split into code-aware chunks (functions, classes,
// methods, doc sections), embedded once, and stored per project; only files that changed are embedded again. Queries mix cosine similarity with a small
// keyword score so exact identifiers still rank well.
const { execFileSync } = require('child_process');
const crypto = require('crypto');
const fs = require('fs');
const path = require('path');
const { isMainThread, parentPort, workerData } = require('worker_threads');
// This file is also the worker that reads and chunks project files (see collect()), where relative requires do not
// resolve, and verify/semantic.mjs loads it in plain Node for the index log checks, so the Electron-bound runtime is
// required by register() alone.

const MODEL_ID = 'google/embeddinggemma-2';
const DIM = 256; // Matryoshka truncation: a quarter of the storage of 768 with little loss for code retrieval
const INDEX_VERSION = 3;
const MAX_FILE_BYTES = 300 * 1024;
const MAX_CHUNKS = 30000;
const CHUNK_CHARS = 1800;
const BATCH = 24;
const TAKE = 200; // files per page handed from the worker to main, so no one message carries a whole project
const SLICE_CHUNKS = 300; // chunks encoded per main-thread slice when the index is written (a few ms each)
const SLICE_MS = 8; // the longest a slice of index loading runs before the main thread gets a turn
const SAVE_DELAY = 2000; // changed files reach the index on disk this long after the last update (and at quit)
const SAVE_EVERY_BATCHES = 40; // a long run saves what it has embedded this often...
const SAVE_EVERY_MS = 20000; // ...or after this long, whichever comes first
const TYPING_PAUSE_MS = 1500; // indexing waits until the user has not typed for this long
const REST_MS = 30; // the embedding server's break between two batches
const TEXT_EXT = new Set(['py', 'pyi', 'md', 'rst', 'txt', 'toml', 'cfg', 'ini', 'yaml', 'yml', 'json', 'js', 'mjs', 'cjs',
  'ts', 'tsx', 'jsx', 'html', 'css', 'java', 'kt', 'lua', 'luau', 'sql', 'sh', 'ps1', 'bat', 'go', 'rs', 'c', 'cpp', 'h', 'cs', 'jsp']);
const SKIP_DIRS = new Set(['.git', 'node_modules', '__pycache__', '.idea', '.vscode', '.mypy_cache', '.pytest_cache',
  '.ruff_cache', '.cache', 'site-packages', 'dist', 'build', '.tox', '.next', 'target']);
const DATA_EXT = new Set(['json', 'txt', 'yaml', 'yml', 'toml', 'cfg', 'ini']); // indexable, but not source

// ---------- chunking ----------
const DEF = /^(\s*)(?:async\s+def|def|class)\s+([A-Za-z_]\w*)/;

function windows(lines, start, end, symbol, size = 40, overlap = 8) {
  const out = [];
  for (let s = start; s < end; s += size - overlap) {
    const e = Math.min(end, s + size);
    out.push({ start: s, end: e, symbol });
    if (e === end) break;
  }
  return out;
}

// Python: one chunk per top-level function/class (decorators included), one per method, and windows over the
// module-level code in between. Long blocks are split so each chunk stays within the model's sweet spot.
function chunkPython(lines) {
  const blocks = [];
  for (let i = 0; i < lines.length; i++) {
    const m = lines[i].match(DEF);
    if (!m || m[1].length) continue;
    let s = i;
    while (s > 0 && /^@/.test(lines[s - 1])) s--;
    blocks.push({ start: s, header: i, name: m[2], isClass: /^class\b/.test(lines[i]) });
  }
  const out = [];
  let cursor = 0;
  blocks.forEach((b, k) => {
    let end = k + 1 < blocks.length ? blocks[k + 1].start : lines.length;
    while (end > b.start + 1 && !lines[end - 1].trim()) end--;
    if (b.start > cursor) out.push(...windows(lines, cursor, b.start, '<module>'));
    const label = `${b.isClass ? 'class' : 'def'} ${b.name}`;
    // A class with methods becomes its header (docstring, class attributes) plus one chunk per method.
    const firstMethod = b.isClass ? lines.slice(b.header + 1, end).findIndex((l) => { const m = l.match(DEF); return m && m[1].length; }) : -1;
    if (firstMethod >= 0) out.push({ start: b.start, end: Math.min(b.header + 1 + firstMethod, b.start + 40), symbol: label });
    else if (end - b.start > 80) out.push(...windows(lines, b.start, end, label, 60, 10));
    else out.push({ start: b.start, end, symbol: label });
    if (firstMethod >= 0) {
      for (let i = b.header + 1; i < end; i++) {
        const m = lines[i].match(DEF);
        if (!m || !m[1].length) continue;
        let mEnd = i + 1;
        while (mEnd < end && (!lines[mEnd].trim() || lines[mEnd].search(/\S/) > m[1].length)) mEnd++;
        let ms = i;
        while (ms > b.header + 1 && /^\s*@/.test(lines[ms - 1])) ms--;
        const sym = `${b.name}.${m[2]}`;
        if (mEnd - ms > 80) out.push(...windows(lines, ms, mEnd, sym, 60, 10));
        else if (mEnd - ms > 2) out.push({ start: ms, end: mEnd, symbol: sym });
      }
    }
    cursor = end;
  });
  if (cursor < lines.length) out.push(...windows(lines, cursor, lines.length, '<module>'));
  return out.filter((c) => lines.slice(c.start, c.end).some((l) => l.trim()));
}

function chunkMarkdown(lines) {
  const heads = [];
  lines.forEach((l, i) => { if (/^#{1,4}\s/.test(l)) heads.push(i); });
  if (!heads.length) return windows(lines, 0, lines.length, '');
  const out = heads[0] > 0 ? windows(lines, 0, heads[0], '') : [];
  heads.forEach((h, k) => {
    const end = k + 1 < heads.length ? heads[k + 1] : lines.length;
    const title = lines[h].replace(/^#+\s*/, '').trim();
    out.push(...(end - h > 60 ? windows(lines, h, end, title, 50, 8) : [{ start: h, end, symbol: title }]));
  });
  return out;
}

function chunkFile(rel, text) {
  const lines = text.split(/\r?\n/);
  const ext = rel.split('.').pop().toLowerCase();
  const chunks = ext === 'py' || ext === 'pyi' ? chunkPython(lines) : ext === 'md' ? chunkMarkdown(lines) : windows(lines, 0, lines.length, '');
  return chunks.map((c) => ({ ...c, text: lines.slice(c.start, c.end).join('\n').slice(0, CHUNK_CHARS) }));
}

// ---------- keyword score ----------
const tokens = (s) => (s.toLowerCase().match(/[\p{L}\p{N}_]{2,}/gu) || [])
  .flatMap((t) => [t, ...t.split('_').filter((p) => p.length > 1)]);
function keywordScore(queryTokens, chunk) {
  if (!queryTokens.length) return 0;
  const hay = `${chunk.symbol} ${chunk.title} ${chunk.text}`.toLowerCase();
  return queryTokens.filter((t) => hay.includes(t)).length / queryTokens.length;
}

// ---------- backends ----------
// A deterministic stand-in (hashed bag of words and identifier parts) used by tests and when no model is installed.
// It runs on the worker thread like the real model runs in its sidecar, so indexing never computes on main.
function fakeEmbed(text) {
  const v = new Float32Array(DIM);
  const parts = tokens(text.replace(/([a-z])([A-Z])/g, '$1 $2'));
  for (const t of parts) {
    const h = crypto.createHash('md5').update(t).digest();
    v[h.readUInt16LE(0) % DIM] += 1;
    v[h.readUInt16LE(2) % DIM] -= 0.5;
  }
  let n = 0;
  for (const x of v) n += x * x;
  n = Math.sqrt(n) || 1;
  for (let i = 0; i < DIM; i++) v[i] /= n;
  return v;
}

// What Git ignores under root, as lowercase root-relative keys with forward slashes: ignored folders once ("data"),
// not every file in them. Not a repository, or no git: nothing.
function gitIgnored(root) {
  let out;
  try {
    out = execFileSync('git', ['-c', 'core.quotepath=false', 'ls-files', '--others', '--ignored', '--exclude-standard', '--directory', '-z'],
      { cwd: root, encoding: 'utf8', timeout: 30000, maxBuffer: 256 << 20, windowsHide: true, stdio: ['ignore', 'pipe', 'ignore'] });
  } catch { return new Set(); }
  return new Set(out.split('\0').filter(Boolean).map((p) => p.replace(/\/$/, '').toLowerCase()));
}
const isVenv = (p, name) => /^\.?venv/i.test(name) || ['pyvenv.cfg', 'conda-meta'].some((m) => fs.existsSync(path.join(p, m)));

// The files to index under root. Left out: SKIP_DIRS, virtual environments at any depth, what Git ignores, the
// user's excluded folders, and data folders: more than `dataFiles` files or `dataMB` of indexable text, of which
// less than a fifth is source. `skipped` lists the folders left out and why.
function walk(root, { ignored = new Set(), excluded = [], dataFiles = 1000, dataMB = 50 } = {}) {
  const out = [];
  const skipped = [];
  const excludedKeys = new Set(excluded.map((r) => r.replace(/\\/g, '/').toLowerCase()));
  const keyOf = (p) => path.relative(root, p).replace(/\\/g, '/').toLowerCase();
  const skip = (p, reason, files) => skipped.push({ rel: path.relative(root, p), reason, ...(files ? { files } : {}) });
  // -> {all, source, bytes}: files of any kind, source files, and bytes of indexable text in the subtree.
  const visit = (dir) => {
    let entries = [];
    try { entries = fs.readdirSync(dir, { withFileTypes: true }); } catch { return { all: 0, source: 0, bytes: 0 }; }
    const first = out.length;
    const firstSkipped = skipped.length;
    const sum = { all: 0, source: 0, bytes: 0 };
    for (const d of entries) {
      const p = path.join(dir, d.name);
      const key = keyOf(p);
      if (d.isDirectory()) {
        if (SKIP_DIRS.has(d.name)) continue;
        if (excludedKeys.has(key)) skip(p, 'excluded');
        else if (ignored.has(key)) skip(p, 'ignored');
        else if (isVenv(p, d.name)) skip(p, 'venv');
        else {
          const s = visit(p);
          sum.all += s.all;
          sum.source += s.source;
          sum.bytes += s.bytes;
        }
        continue;
      }
      sum.all++;
      const ext = d.name.split('.').pop().toLowerCase();
      if (!TEXT_EXT.has(ext) || ignored.has(key)) continue;
      let st;
      try { st = fs.statSync(p); } catch { continue; }
      if (!(st.size > 0 && st.size <= MAX_FILE_BYTES)) continue;
      out.push({ abs: p, rel: path.relative(root, p), mtime: st.mtimeMs, size: st.size });
      sum.bytes += st.size;
      if (!DATA_EXT.has(ext)) sum.source++;
    }
    if (dir !== root && (sum.all > dataFiles || sum.bytes > dataMB * 2 ** 20) && sum.source * 5 < sum.all) {
      out.length = first;
      skipped.length = firstSkipped; // the data folders inside it go with it
      skip(dir, 'data', sum.all);
      // Its parent is judged without it, so a package with a large fixtures folder keeps its code.
      return { all: 0, source: 0, bytes: 0 };
    }
    return sum;
  };
  visit(root);
  return { files: out, skipped };
}

// The folders holding the most chunks, two levels deep, for the size prompt and the exclude picker.
function heaviest(entries, n = 12) {
  const by = new Map();
  for (const [rel, chunks] of entries) {
    const parts = rel.split(/[\\/]/).slice(0, -1);
    for (let d = 1; d <= Math.min(2, parts.length); d++) {
      const dir = parts.slice(0, d).join(path.sep);
      const e = by.get(dir) || by.set(dir, { rel: dir, files: 0, chunks: 0 }).get(dir);
      e.files++;
      e.chunks += chunks;
    }
  }
  return [...by.values()].sort((a, b) => b.chunks - a.chunks).slice(0, n);
}

// The disk half of an index update, run on a worker thread so a large project never stalls the main process:
// which files are gone or changed, and the changed ones read and chunked. `known` is what the index holds, as one
// flat array [rel, mtime, size, chunks, rel, ...] (chunks = how many it holds for the file): one array crosses the
// thread boundary in a few ms where 20k small objects take tens. The changed files wait here, under their root, and
// main takes them a page at a time (take), so a 20k-file project never crosses to main in one message either and
// two projects indexing at once never take each other's files.
// `opts` are the walk's limits and exclusions (see walk); Git is asked for its ignored paths here, off the main thread.
const queued = new Map(); // root -> changed files not yet taken
function collect(root, knownFlat, onlyPaths, opts = {}) {
  const known = new Map();
  for (let i = 0; i < knownFlat.length; i += 4) known.set(knownFlat[i], { mtime: knownFlat[i + 1], size: knownFlat[i + 2], chunks: knownFlat[i + 3] });
  const { files: disk, skipped } = walk(root, { ...opts, ignored: gitIgnored(root) });
  const seen = new Set(disk.map((f) => f.rel.toLowerCase()));
  let stale = disk.filter((f) => { const old = known.get(f.rel); return !old || old.mtime !== f.mtime || old.size !== f.size; });
  if (onlyPaths) stale = stale.filter((f) => onlyPaths.some((p) => p.toLowerCase() === f.abs.toLowerCase()) || !known.has(f.rel));
  const staleRels = new Set(stale.map((f) => f.rel));
  let budget = MAX_CHUNKS;
  for (const [rel, k] of known) if (seen.has(rel.toLowerCase()) && !staleRels.has(rel)) budget -= k.chunks;
  const work = [];
  let capped = false;
  for (const f of stale) {
    let text;
    try { text = fs.readFileSync(f.abs, 'utf8'); } catch { continue; }
    if (text.includes('\u0000')) continue;
    const chunks = chunkFile(f.rel, text).map((c) => ({ ...c, title: f.rel.replace(/\\/g, '/') }));
    if (chunks.length > budget) { capped = true; break; }
    budget -= chunks.length;
    work.push({ f, chunks });
  }
  queued.set(root, work);
  return { seen: [...seen], files: work.length, chunks: work.reduce((n, w) => n + w.chunks.length, 0), capped,
    skipped: skipped.slice(0, 500), heavy: heaviest(work.map((w) => [w.f.rel, w.chunks.length])) };
}
const drop = (root) => { queued.delete(root); };
const fakeEmbedAll = (items) => items.map((it) => fakeEmbed(`${it.title || ''} ${it.text}`));
// The next page of a root's changed files; with `embed`, their chunks come back already embedded by the test backend
// (one round trip per page instead of one per batch, which adds up to seconds on a 20k-file project).
function take(root, n, embed) {
  const page = (queued.get(root) || []).splice(0, n);
  if (!page.length) queued.delete(root);
  if (embed) for (const w of page) fakeEmbedAll(w.chunks.map((c) => ({ title: c.symbol ? `${c.title} ${c.symbol}` : c.title, text: c.text }))).forEach((v, i) => { w.chunks[i].vector = v; });
  return page;
}

const WORKER_OPS = { collect, take, drop, fakeEmbed: fakeEmbedAll };
if (!isMainThread && workerData?.role === 'pyide-semantic') {
  parentPort.on('message', ({ id, op, args }) => {
    try { parentPort.postMessage({ id, result: WORKER_OPS[op](...args) }); } catch (e) { parentPort.postMessage({ id, error: e.message }); }
  });
}
const inWorker = isMainThread ? require('../worker-host').fileWorker(__filename, 'pyide-semantic') : null;
const yieldTurn = () => new Promise((resolve) => setImmediate(resolve));
const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

// ---------- the index on disk ----------
// In memory: files = {rel: {mtime, size, chunks: [{start, end, symbol, title, text, vector}]}}. On disk, in the
// index's dir: index.jsonl, a header line then one [rel, record | null] line per change (a null is a deleted file;
// the last line for a path wins), and the vector file the header names, DIM float32 per chunk in the order the
// records' `v` give. Changes are appended, so a save costs its own size, not the project's; when more than half of
// the log is stale, or the log on disk is not one this version wrote intact (never saved, another version's header,
// a write that failed), the whole index is rewritten into a new vector file. Both are read and written in slices
// that yield to the event loop, since a 20k-file project's index runs to tens of MB.
const ROW_BYTES = DIM * 4;
const indexFile = (idx) => path.join(idx.dir, 'index.jsonl');
const vectorFile = (idx, name = idx.vectors) => path.join(idx.dir, name);
const newVectors = () => `vectors-${Date.now().toString(36)}.bin`;
const header = (idx, vectors) => `${JSON.stringify({ version: INDEX_VERSION, backend: idx.backend, dim: DIM, root: idx.root, vectors })}\n`;
const newIndex = (root, dir, backend) => ({
  root, dir, backend, files: {}, chunks: 0, job: null, done: 0, total: 0, capped: false, sentAt: 0,
  vectors: newVectors(), onDisk: false, records: 0, // the log on disk: its vector file, whether it is intact and appendable, records in index.jsonl
  pending: new Map(), saveTimer: null, io: Promise.resolve(), writing: null, // changes not yet on disk; the save in flight (saves run one at a time)
});

// fs.promises.readFile reads a file in 512 KB pieces and joins them on the main thread, tens of ms for a large
// index; one read into a buffer of the file's size costs the main thread nothing.
async function readWhole(file) {
  const fh = await fs.promises.open(file, 'r');
  try {
    const { size } = await fh.stat();
    const buf = Buffer.allocUnsafe(size);
    let got = 0;
    while (got < size) {
      const { bytesRead } = await fh.read(buf, got, size - got, got);
      if (!bytesRead) break;
      got += bytesRead;
    }
    return buf.subarray(0, got);
  } finally {
    await fh.close();
  }
}

async function readIndex(idx) {
  let log;
  try { log = await readWhole(indexFile(idx)); } catch { return; }
  let cursor = 0;
  const nextLine = () => {
    const nl = log.indexOf(10, cursor);
    if (nl < 0) return null;
    const line = log.toString('utf8', cursor, nl);
    cursor = nl + 1;
    return line;
  };
  let head;
  try { head = JSON.parse(nextLine()); } catch { return; }
  if (!(head?.version === INDEX_VERSION && head.backend === idx.backend && head.dim === DIM && typeof head.vectors === 'string')) return;
  let vec;
  try { vec = await readWhole(vectorFile(idx, head.vectors)); } catch { return; }
  // A row a crash cut short at the end of the vector file is ignored; the next save overwrites it.
  const rows = Math.floor(vec.byteLength / ROW_BYTES);
  const all = new Float32Array(vec.buffer, vec.byteOffset, rows * DIM);
  let records = 0;
  let onDisk = true;
  let t = performance.now();
  for (let line = nextLine(); line !== null; line = nextLine()) {
    records++;
    let rel, f;
    try { [rel, f] = JSON.parse(line); } catch { continue; } // a line cut short by a crash mid-append
    // A line of another shape (a damaged file) is skipped the same way; read as a record it threw, and the project's
    // index never loaded again.
    if (typeof rel !== 'string' || (f && !(Array.isArray(f.chunks) && f.chunks.every((c) => c && typeof c.text === 'string')))) continue;
    forget(idx, rel, true);
    // Records whose vectors never made it to disk are dropped, so the file is embedded again. Their lines stay,
    // pointing at rows the next append would fill, so that save rewrites the log instead.
    if (f && f.chunks.every((c) => c.v < rows)) {
      const title = rel.replace(/\\/g, '/');
      for (const c of f.chunks) {
        c.title = title;
        c.vector = all.subarray(c.v * DIM, (c.v + 1) * DIM);
        delete c.v;
      }
      remember(idx, rel, f, true);
    } else if (f) onDisk = false;
    if (performance.now() - t > SLICE_MS) { await yieldTurn(); t = performance.now(); }
  }
  // A last line a crash cut short (there is no newline after it) is cut off, or the next record appended would
  // join it and be lost with it.
  if (cursor < log.length) await fs.promises.truncate(indexFile(idx), cursor).catch(() => { onDisk = false; });
  Object.assign(idx, { vectors: head.vectors, onDisk, records });
  await dropStrays(idx);
}
// Vector files other than the one the log names (a crash between a rewrite's two steps, a replaced log), and the
// pre-v3 index file.
async function dropStrays(idx) {
  for (const name of await fs.promises.readdir(idx.dir).catch(() => [])) {
    if ((name !== idx.vectors && /^vectors.*\.bin$/.test(name)) || name === 'index.json') await fs.promises.rm(path.join(idx.dir, name), { force: true }).catch(() => {});
  }
}

const remember = (idx, rel, f, loading) => {
  idx.files[rel] = f;
  idx.chunks += f.chunks.length;
  if (!loading) idx.pending.set(rel, f);
};
const forget = (idx, rel, loading) => {
  const old = idx.files[rel];
  if (!old) return;
  idx.chunks -= old.chunks.length;
  delete idx.files[rel];
  if (!loading) idx.pending.set(rel, null);
};

// Log lines and vectors for [rel, record | null] entries, with `row` the next free row of the vector file.
function encode(entries, row) {
  const lines = [];
  const vecs = [];
  for (const [rel, f] of entries) {
    const rec = f && { mtime: f.mtime, size: f.size, chunks: f.chunks.map((c) => { vecs.push(c.vector); return { start: c.start, end: c.end, symbol: c.symbol, text: c.text, v: row++ }; }) };
    lines.push(`${JSON.stringify([rel, rec])}\n`);
  }
  const all = new Float32Array(vecs.length * DIM);
  vecs.forEach((v, i) => all.set(v, i * DIM));
  return { text: Buffer.from(lines.join('')), vectors: Buffer.from(all.buffer), row };
}
// The same in slices of SLICE_CHUNKS chunks, each followed by a turn of the event loop.
async function encodeSliced(entries, row) {
  const text = [];
  const vectors = [];
  for (let i = 0; i < entries.length;) {
    let j = i;
    for (let n = 0; j < entries.length && n < SLICE_CHUNKS; j++) n += entries[j][1]?.chunks.length || 1;
    const e = encode(entries.slice(i, j), row);
    text.push(e.text);
    vectors.push(e.vectors);
    row = e.row;
    i = j;
    await yieldTurn();
  }
  return { text, vectors };
}
async function writeParts(file, flag, parts) {
  const fh = await fs.promises.open(file, flag);
  try { await fh.writev(parts); } finally { await fh.close(); }
}

// A save takes the pending changes and either appends them to the log or rewrites the whole index (compact). Only
// one runs at a time: `writing` is the one in flight from the moment it takes the changes, as it encodes in slices
// and a second writer in between would put rows where its records do not point. A save that fails puts its changes
// back (changes made meanwhile win) and leaves the log not known-good, so the next save rewrites everything.
const needsRewrite = (idx) => !idx.onDisk || idx.records + idx.pending.size > 2 * Object.keys(idx.files).length + 1000;
const afterWrite = (idx, next) => idx.writing.then(next, next);
function takePending(idx) {
  const batch = [...idx.pending];
  idx.pending = new Map();
  return batch;
}
function restorePending(idx, batch) {
  for (const [rel, f] of batch) if (!idx.pending.has(rel)) idx.pending.set(rel, f);
  idx.onDisk = false;
}
const save = (idx, batch, work) => (idx.writing = work.catch((err) => { restorePending(idx, batch); throw err; }).finally(() => { idx.writing = null; }));
// Rows are appended where the vector file really ends (a crash may have left part of a row, a failed save rows
// without records), and vectors go before their records: a record never points beside its vectors.
async function alignedRows(fh) {
  const { size } = await fh.stat();
  const rows = Math.floor(size / ROW_BYTES);
  if (size !== rows * ROW_BYTES) await fh.truncate(rows * ROW_BYTES);
  return rows;
}
async function appendLog(idx, batch) {
  await fs.promises.mkdir(idx.dir, { recursive: true });
  const fh = await fs.promises.open(vectorFile(idx), fs.constants.O_RDWR | fs.constants.O_CREAT);
  let text;
  try {
    const rows = await alignedRows(fh);
    let vectors;
    ({ text, vectors } = await encodeSliced(batch, rows));
    vectors = vectors.filter((b) => b.length);
    if (vectors.length) await fh.writev(vectors, rows * ROW_BYTES);
  } finally {
    await fh.close();
  }
  await writeParts(indexFile(idx), 'a', text);
  idx.records += batch.length;
}
async function rewriteLog(idx, entries) {
  const fresh = newVectors();
  const { text, vectors } = await encodeSliced(entries, 0);
  await fs.promises.mkdir(idx.dir, { recursive: true });
  await writeParts(vectorFile(idx, fresh), 'w', vectors);
  await writeParts(`${indexFile(idx)}.tmp`, 'w', [Buffer.from(header(idx, fresh)), ...text]);
  await fs.promises.rename(`${indexFile(idx)}.tmp`, indexFile(idx));
  Object.assign(idx, { vectors: fresh, onDisk: true, records: entries.length });
  await dropStrays(idx);
}
async function flush(idx) {
  if (idx.writing) return afterWrite(idx, () => flush(idx));
  if (!idx.pending.size) return;
  if (needsRewrite(idx)) return compact(idx);
  const batch = takePending(idx);
  return save(idx, batch, appendLog(idx, batch));
}
async function compact(idx) {
  if (idx.writing) return afterWrite(idx, () => compact(idx));
  const batch = takePending(idx);
  return save(idx, batch, rewriteLog(idx, Object.entries(idx.files)));
}
// At quit there is no event loop left to wait on: the save is done in one go. A save already in flight finishes
// first, and this one follows it (the quit waits on other work for a while; if the process is gone by then, the
// next launch finds what a crash leaves, which the reader handles).
function flushSync(idx) {
  if (idx.writing) { afterWrite(idx, () => { try { flushSync(idx); } catch {} }); return; }
  if (!idx.pending.size) return;
  const rewrite = needsRewrite(idx);
  const batch = takePending(idx);
  try {
    fs.mkdirSync(idx.dir, { recursive: true });
    if (rewrite) {
      const entries = Object.entries(idx.files);
      const fresh = newVectors();
      const { text, vectors } = encode(entries, 0);
      fs.writeFileSync(vectorFile(idx, fresh), vectors);
      fs.writeFileSync(`${indexFile(idx)}.tmp`, Buffer.concat([Buffer.from(header(idx, fresh)), text]));
      fs.renameSync(`${indexFile(idx)}.tmp`, indexFile(idx));
      Object.assign(idx, { vectors: fresh, onDisk: true, records: entries.length });
    } else {
      const fd = fs.openSync(vectorFile(idx), fs.constants.O_RDWR | fs.constants.O_CREAT);
      let text;
      try {
        const { size } = fs.fstatSync(fd);
        const rows = Math.floor(size / ROW_BYTES);
        if (size !== rows * ROW_BYTES) fs.ftruncateSync(fd, rows * ROW_BYTES);
        let vectors;
        ({ text, vectors } = encode(batch, rows));
        if (vectors.length) fs.writeSync(fd, vectors, 0, vectors.length, rows * ROW_BYTES);
      } finally {
        fs.closeSync(fd);
      }
      fs.appendFileSync(indexFile(idx), text);
      idx.records += batch.length;
    }
  } catch (err) {
    restorePending(idx, batch);
    throw err;
  }
}

exports.register = ({ ipcMain, app, send, unpackedDir }) => {
  const runtime = require('../ai/runtime');
  const base = path.join(app.getPath('userData'), 'semantic');
  const server = path.join(unpackedDir, 'main', 'semantic', 'embed_server.py');
  const fake = process.env.PYIDE_SEMANTIC_BACKEND === 'fake';
  // Tests: the test backend takes this long per page of files, so a run can be paused or killed part-way.
  const fakePageMs = fake ? Number(process.env.PYIDE_SEMANTIC_FAKE_PAGE_MS) || 0 : 0;
  const backend = fake ? 'fake' : MODEL_ID;
  const modelDownloaded = () => !!runtime.hfCachedFile(MODEL_ID, 'model.safetensors');

  // ---------- runtime state ----------
  // Setup only installs torchvision after torch is importable, so its presence stands for the whole runtime.
  const runtimeInstalled = () => ['sentence_transformers', 'transformers', 'torchvision'].every(runtime.hasPackage);
  let model = { state: 'idle', device: null, error: null };
  const status = () => (fake
    ? { backend: 'fake', runtime: true, downloaded: true, model: { state: 'ready', device: 'cpu' }, modelId: 'hashing (test)', dim: DIM }
    : { backend: 'embeddinggemma-2', runtime: runtime.pythonReady() && runtimeInstalled(), downloaded: modelDownloaded(), model, modelId: MODEL_ID, dim: DIM });
  const pushStatus = () => send('semantic:status', status());

  // ---------- sidecar ----------
  let sidecar = null;
  let idleMs = runtime.idleMsOf(); // the renderer passes the user's setting (semantic:configure)
  function startServer() {
    if (sidecar?.alive()) return sidecar;
    const sc = runtime.startSidecar({
      script: server,
      idleMs: () => idleMs,
      onEvent: (msg) => {
        if (msg.event === 'loading') model = { state: 'loading', device: null, error: null };
        else if (msg.event === 'ready') model = { state: 'ready', device: msg.device, threads: msg.threads, error: null };
        pushStatus();
      },
      onLog: (text) => send('semantic:log', text),
      onExit: (code) => {
        // A server stopped for being idle may already have a successor whose events own the state.
        if (sidecar !== sc) return;
        if (model.state !== 'ready') model = { state: 'error', device: null, error: `embedding server exited (${code})` };
        else model = { state: 'idle', device: null, error: null };
        pushStatus();
      },
    });
    sidecar = sc;
    return sc;
  }

  async function embed(items, kind) {
    if (fake) return inWorker('fakeEmbed', items);
    if (!status().runtime) throw new Error('EmbeddingGemma 2 is not set up');
    const reply = await startServer().send({ op: 'embed', kind, items, dim: DIM }).reply;
    if (reply.error) {
      // A model that failed to load stays unloaded (the server tries again on the next request); left at 'loading',
      // the status bar would say "Loading EmbeddingGemma 2…" for good.
      model = { ...model, state: model.state === 'loading' ? 'error' : model.state, error: reply.error };
      pushStatus();
      throw new Error(reply.error);
    }
    const buf = Buffer.from(reply.data, 'base64');
    const all = new Float32Array(buf.buffer, buf.byteOffset, buf.byteLength / 4);
    return Array.from({ length: reply.n }, (_, i) => all.slice(i * reply.dim, (i + 1) * reply.dim));
  }

  // ---------- per-project index ----------
  const indexes = new Map(); // root key -> idx (newIndex)
  const keyOf = (root) => crypto.createHash('sha1').update(root.toLowerCase()).digest('hex').slice(0, 16);
  function loadIndex(root) {
    const k = keyOf(root);
    if (!indexes.has(k)) {
      const idx = newIndex(root, path.join(base, 'indexes', k), backend);
      idx.loaded = readIndex(idx).catch(() => {});
      indexes.set(k, idx);
    }
    const idx = indexes.get(k);
    return idx.loaded.then(() => idx);
  }
  function scheduleSave(idx) {
    clearTimeout(idx.saveTimer);
    idx.saveTimer = setTimeout(() => {
      idx.saveTimer = null;
      idx.io = idx.io.then(() => flush(idx)).catch((err) => send('semantic:log', `index save failed: ${err.message}\n`));
    }, SAVE_DELAY);
  }

  // A save now rather than SAVE_DELAY from now: during a long run, when indexing pauses, at quit.
  function saveNow(idx) {
    clearTimeout(idx.saveTimer);
    idx.saveTimer = null;
    if (idx.pending.size) idx.io = idx.io.then(() => flush(idx)).catch((err) => send('semantic:log', `index save failed: ${err.message}\n`));
  }

  // ---------- limits, pause, typing, exclusions ----------
  // The renderer passes the user's settings (semantic:configure); confirmChunks is the size of a first index above
  // which the user is asked before it starts.
  const limits = { dataFiles: 1000, dataMB: 50, confirmChunks: 5000 };
  let paused = false; // Pause Indexing, for every project, until Resume or the next launch
  let typingAt = 0; // the renderer reports edits (semantic:typing); indexing waits until the user stops typing
  const exclusionsFile = path.join(base, 'exclusions.json');
  let exclusions = null; // {root key: [project-relative folder]}
  const excludedOf = (root) => {
    if (!exclusions) { try { exclusions = JSON.parse(fs.readFileSync(exclusionsFile, 'utf8')); } catch { exclusions = {}; } }
    if (!exclusions || typeof exclusions !== 'object' || Array.isArray(exclusions)) exclusions = {};
    const rels = exclusions[keyOf(root)];
    return Array.isArray(rels) ? rels.filter((r) => typeof r === 'string') : [];
  };
  async function setExcluded(root, rels) {
    excludedOf(root);
    if (rels.length) exclusions[keyOf(root)] = rels; else delete exclusions[keyOf(root)];
    await fs.promises.mkdir(base, { recursive: true });
    await fs.promises.writeFile(exclusionsFile, JSON.stringify(exclusions, null, 1));
  }
  // The project the window shows (semantic:index, semantic:confirm, ...): a run for any other project stops at its
  // next turn, after saving what it embedded, and resumes when that project is opened again.
  let activeKey = null;
  const setActive = (root) => { activeKey = root ? keyOf(root) : null; };
  // Waits while indexing is paused or the user is typing. Searches do not wait: they embed on their own.
  async function waitTurn(away) {
    while ((paused || Date.now() - typingAt < TYPING_PAUSE_MS) && !away()) await sleep(paused ? 200 : TYPING_PAUSE_MS - (Date.now() - typingAt) + 20);
  }

  // At most ten progress messages a second while indexing; phase changes always go out. `eta` is in seconds, from
  // the recent embedding rate (paused time not counted).
  const progress = (idx, phase, force) => {
    const now = Date.now();
    if (!force && now - idx.sentAt < 100) return;
    idx.sentAt = now;
    const eta = phase === 'indexing' && idx.msPerChunk ? Math.round(((idx.total - idx.done) * idx.msPerChunk) / 1000) : null;
    send('semantic:progress', { root: idx.root, phase, done: idx.done, total: idx.total, files: Object.keys(idx.files).length, chunks: idx.chunks,
      capped: idx.capped, paused, eta, skipped: idx.skipped?.length || 0, asking: idx.asking || null });
  };

  // Brings the index up to date with the files on disk; concurrent calls share one run. Each file reaches the index
  // as soon as its last chunk is embedded, and the index is saved every SAVE_EVERY_BATCHES batches or SAVE_EVERY_MS,
  // so a restart resumes where the run stopped. A first index larger than limits.confirmChunks waits for the user's
  // answer (semantic:confirm); after a no, the project is not indexed until the user asks (`confirmed`).
  async function update(root, onlyPaths, { confirmed } = {}) {
    const idx = await loadIndex(root);
    if (confirmed) Object.assign(idx, { confirmed: true, declined: false });
    if (idx.declined) return;
    if (idx.job) { idx.rerun = true; return idx.job; }
    const away = () => keyOf(root) !== activeKey;
    idx.job = (async () => {
      try {
        do {
          idx.rerun = false;
          const known = [];
          for (const rel in idx.files) known.push(rel, idx.files[rel].mtime, idx.files[rel].size, idx.files[rel].chunks.length);
          const { dataFiles, dataMB } = limits;
          const plan = await inWorker('collect', root, known, onlyPaths, { dataFiles, dataMB, excluded: excludedOf(root) });
          const seenSet = new Set(plan.seen);
          for (const rel of Object.keys(idx.files)) if (!seenSet.has(rel.toLowerCase())) forget(idx, rel);
          Object.assign(idx, { capped: plan.capped, skipped: plan.skipped, total: plan.chunks, done: 0, msPerChunk: 0 });
          if (!idx.confirmed && !Object.keys(idx.files).length && plan.chunks > limits.confirmChunks) {
            idx.asking = { files: plan.files, chunks: plan.chunks, heavy: plan.heavy, skipped: plan.skipped.length };
            progress(idx, 'confirm', true);
            // true, false, or 'again': yes after excluding folders, so the files are collected again without them.
            const answer = await new Promise((resolve) => { idx.answer = resolve; });
            Object.assign(idx, { asking: null, answer: null, confirmed: !!answer, declined: !answer });
            if (answer !== true) {
              await inWorker('drop', root);
              idx.rerun = !!answer;
              if (answer) continue;
              progress(idx, 'declined', true);
              return;
            }
          }
          progress(idx, 'indexing', true);
          let batches = 0;
          let savedAt = Date.now();
          const saveEvery = (n) => {
            batches += n;
            if (batches < SAVE_EVERY_BATCHES && Date.now() - savedAt <= SAVE_EVERY_MS) return;
            batches = 0;
            savedAt = Date.now();
            saveNow(idx);
          };
          const timed = (started, n) => {
            const ms = (Date.now() - started) / n;
            idx.msPerChunk = idx.msPerChunk ? 0.8 * idx.msPerChunk + 0.2 * ms : ms;
          };
          pages: for (;;) {
            await waitTurn(away);
            if (away()) break;
            const pageStarted = Date.now();
            const page = await inWorker('take', root, TAKE, fake);
            if (!page.length) break;
            if (fakePageMs) await sleep(fakePageMs);
            const left = new Map(page.map((w) => [w, w.chunks.filter((c) => !c.vector).length]));
            const finish = (w) => {
              forget(idx, w.f.rel);
              remember(idx, w.f.rel, { mtime: w.f.mtime, size: w.f.size, chunks: w.chunks });
            };
            const ready = page.filter((w) => !left.get(w));
            for (const w of ready) { finish(w); idx.done += w.chunks.length; }
            const readyChunks = ready.reduce((n, w) => n + w.chunks.length, 0);
            if (readyChunks) {
              timed(pageStarted, readyChunks);
              saveEvery(Math.ceil(readyChunks / BATCH));
            }
            const items = page.flatMap((w) => w.chunks.filter((c) => !c.vector).map((c) => [w, c]));
            for (let i = 0; i < items.length; i += BATCH) {
              await waitTurn(away);
              if (away()) break pages;
              const started = Date.now();
              const batch = items.slice(i, i + BATCH);
              const vecs = await embed(batch.map(([, c]) => ({ title: c.symbol ? `${c.title} ${c.symbol}` : c.title, text: c.text })), 'document');
              batch.forEach(([w, c], j) => {
                c.vector = vecs[j];
                left.set(w, left.get(w) - 1);
                if (!left.get(w)) finish(w);
              });
              idx.done += batch.length;
              await sleep(REST_MS);
              timed(started, batch.length);
              saveEvery(1);
              progress(idx, 'indexing');
            }
            progress(idx, 'indexing');
          }
          if (away()) {
            // Files whose chunks were not all embedded are not in the index, so the next run collects them again.
            await inWorker('drop', root);
            saveNow(idx);
            return;
          }
          onlyPaths = null;
        } while (idx.rerun);
        if (idx.pending.size) scheduleSave(idx);
        progress(idx, 'ready', true);
      } catch (err) {
        send('semantic:progress', { root, phase: 'error', error: String(err.message || err) });
      } finally {
        idx.job = null;
      }
    })();
    return idx.job;
  }

  async function search(root, query, { limit = 30, similarTo } = {}) {
    const idx = await loadIndex(root);
    // Code-to-code similarity compares like with like: the selection is embedded as a document, the space the index lives in.
    const [q] = similarTo ? await embed([{ text: similarTo }], 'document') : await embed([{ text: query }], 'query');
    const qt = similarTo ? [] : tokens(query || '');
    const candidates = [];
    for (const [rel, f] of Object.entries(idx.files)) {
      for (const c of f.chunks) {
        if (!c.vector) continue;
        let dot = 0;
        for (let i = 0; i < DIM; i++) dot += c.vector[i] * q[i];
        candidates.push({ rel, c, dot });
      }
    }
    // The keyword score scans each chunk's text (hundreds of ms on the main process for a full index), but adds at
    // most KEYWORD_WEIGHT. So chunks are scored best cosine first, in growing batches, until no chunk left could
    // still reach the results: the outcome is the same as scoring every chunk.
    const KEYWORD_WEIGHT = 0.15;
    candidates.sort((a, b) => b.dot - a.dot);
    const scored = [];
    let out = [];
    for (let i = 0, batch = Math.max(256, limit * 8); ; batch *= 2) {
      for (const end = Math.min(candidates.length, i + batch); i < end; i++) {
        const { rel, c, dot } = candidates[i];
        const kw = keywordScore(qt, c);
        scored.push({ rel, start: c.start, end: c.end, symbol: c.symbol, score: dot + KEYWORD_WEIGHT * kw, semantic: dot, keyword: kw, text: c.text });
      }
      scored.sort((a, b) => b.score - a.score);
      // One hit per symbol region: drop overlapping windows of an already listed chunk. A chunk not scored yet ranks
      // below every listed hit, so it could not have hidden one of them.
      out = [];
      for (const r of scored) {
        if (out.some((o) => o.rel === r.rel && r.start < o.end && o.start < r.end)) continue;
        out.push(r);
        if (out.length >= limit) break;
      }
      if (i >= candidates.length || (out.length >= limit && out[out.length - 1].score >= candidates[i].dot + KEYWORD_WEIGHT)) break;
    }
    return out.map((r) => ({ ...r, path: path.join(root, r.rel), preview: r.text.split('\n').slice(0, 12).join('\n'), text: undefined }));
  }

  // ---------- setup: shared runtime, packages, model download ----------
  let setupJob = null;
  ipcMain.handle('semantic:setup', async (_e, { interpreter } = {}) => {
    if (fake) return { ok: true };
    const job = setupJob = runtime.createJob((text) => send('semantic:log', text));
    try {
      await runtime.exclusive(async () => {
        await runtime.ensureVenv(job, interpreter);
        if (runtimeInstalled()) return;
        const hasTorch = runtime.canImport('torch');
        // Upgrading only the small packages keeps the reused system torch instead of downloading a new one.
        await runtime.pipInstall(job, ['--upgrade', 'sentence-transformers>=6.1', 'transformers', 'huggingface_hub', ...(hasTorch ? [] : ['torch'])]);
        // EmbeddingGemma 2's processor loads its video processor even for text, and that needs torchvision.
        await runtime.installTorchvision(job);
      });
      pushStatus();
      if (!modelDownloaded()) await runtime.hfDownload(job, MODEL_ID);
      pushStatus();
      return { ok: true };
    } catch (err) {
      pushStatus();
      return { ok: false, error: String(err.message || err) };
    } finally {
      if (setupJob === job) setupJob = null;
    }
  });
  ipcMain.handle('semantic:cancelSetup', () => setupJob?.cancel());

  ipcMain.handle('semantic:status', () => status());
  ipcMain.handle('semantic:configure', (_e, { idleMinutes, ...rest } = {}) => {
    idleMs = runtime.idleMsOf(idleMinutes);
    sidecar?.idle();
    for (const k of Object.keys(limits)) if (Number(rest[k]) > 0) limits[k] = Number(rest[k]);
  });
  // Also says which project the window shows; null when it shows none.
  ipcMain.handle('semantic:index', (_e, root, paths) => { setActive(root); if (root) update(root, paths); return true; });
  ipcMain.on('semantic:typing', () => { typingAt = Date.now(); });
  ipcMain.handle('semantic:pause', (_e, on) => {
    paused = !!on;
    for (const idx of indexes.values()) {
      if (!idx.job) continue;
      progress(idx, 'indexing', true);
      if (paused) saveNow(idx);
    }
    return paused;
  });
  // A project folder as a relative path, or null for the root itself and paths outside it.
  const folderRel = (root, folder) => {
    const rel = path.relative(root, path.resolve(root, folder));
    return !rel || rel.startsWith('..') || path.isAbsolute(rel) ? null : rel;
  };
  const withExcluded = (root, folders, on) => {
    let list = excludedOf(root);
    for (const rel of folders.map((f) => folderRel(root, f)).filter(Boolean)) {
      list = list.filter((r) => r.toLowerCase() !== rel.toLowerCase());
      if (on) list.push(rel);
    }
    return setExcluded(root, list);
  };
  // The answer to a first index's size question, optionally with folders to exclude first; a yes without a question
  // pending starts indexing a project the user said no to.
  ipcMain.handle('semantic:confirm', async (_e, root, yes, exclude = []) => {
    setActive(root);
    const idx = await loadIndex(root);
    if (yes && exclude.length) await withExcluded(root, exclude, true);
    if (idx.answer) idx.answer(yes ? (exclude.length ? 'again' : true) : false);
    else if (yes) update(root, null, { confirmed: true });
    return true;
  });
  // Excludes (on) or includes again a project folder; the index drops or picks up its files right away.
  ipcMain.handle('semantic:exclude', async (_e, root, folder, on) => {
    setActive(root);
    await withExcluded(root, [folder], on);
    update(root);
    return excludedOf(root);
  });
  ipcMain.handle('semantic:rebuild', async (_e, root) => {
    setActive(root);
    const idx = await loadIndex(root);
    idx.io = idx.io.then(async () => {
      Object.assign(idx, { files: {}, chunks: 0, pending: new Map(), vectors: newVectors(), onDisk: false, records: 0 });
      await fs.promises.rm(idx.dir, { recursive: true, force: true });
    }).catch(() => {});
    await idx.io;
    update(root, null, { confirmed: true });
    return true;
  });
  ipcMain.handle('semantic:query', async (_e, root, query, opts) => {
    try { return { ok: true, results: await search(root, query, opts) }; } catch (err) { return { ok: false, error: String(err.message || err) }; }
  });
  ipcMain.handle('semantic:indexInfo', async (_e, root) => {
    const idx = await loadIndex(root);
    return { files: Object.keys(idx.files).length, chunks: idx.chunks, indexing: !!idx.job, capped: idx.capped, paused,
      asking: idx.asking || null, declined: !!idx.declined, skipped: idx.skipped || [], excluded: excludedOf(root),
      heavy: heaviest(Object.entries(idx.files).map(([rel, f]) => [rel, f.chunks.length])) };
  });

  app.on('before-quit', () => {
    for (const idx of indexes.values()) {
      clearTimeout(idx.saveTimer);
      try { flushSync(idx); } catch {}
    }
    sidecar?.kill();
  });
};

exports._test = { chunkFile, chunkPython, keywordScore, tokens, fakeEmbed, walk, gitIgnored, collect, take, newIndex, readIndex, remember, forget, flush, compact, flushSync };
