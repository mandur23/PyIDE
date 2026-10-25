// How many of the project's Python files mention a name, for code vision's usage counts
// (renderer/features/code-vision). Pyright's references request parses and binds every project file whose text holds
// the name, so counting a name found in thousands of files took 15 s of Pyright's only request thread and grew it by
// 2 GB; code vision asks this first and counts such names only on click. A worker keeps a word -> number of files
// index of the project's .py/.pyi files, and checks each file's mtime and size again when the renderer says files
// changed (a new `epoch`).
const fs = require('fs');
const path = require('path');
const { isMainThread, parentPort, workerData } = require('worker_threads');

// As Find in Files (main/features/search.js) and Pyright's defaults: no caches, VCS folders or virtualenvs.
const SKIP_DIRS = new Set(['.git', '.hg', '.svn', '__pycache__', 'node_modules', '.idea', '.mypy_cache', '.pytest_cache',
  '.ruff_cache', '.tox', '.nox', '.venv', 'venv', 'env', 'site-packages']);
const MAX_FILES = 20000;
const MAX_SIZE = 2 * 1024 * 1024;
const PARALLEL = 32;
const PY = /\.pyi?$/i;
// Identifiers as Python spells them, closely enough: an upper bound of where Pyright looks (comments and strings count).
const WORD = /[A-Za-z_ª-￿][\wª-￿]*/g;

function pyFiles(root) {
  const out = [];
  const visit = (dir) => {
    let entries;
    try { entries = fs.readdirSync(dir, { withFileTypes: true }); } catch { return; }
    if (dir !== root && entries.some((d) => d.name === 'pyvenv.cfg')) return;
    for (const d of entries) {
      if (out.length >= MAX_FILES) return;
      const p = path.join(dir, d.name);
      if (d.isDirectory()) { if (!SKIP_DIRS.has(d.name)) visit(p); } else if (d.isFile() && PY.test(d.name)) out.push(p);
    }
  };
  visit(root);
  return out;
}

// {root, epoch, files: Map(path -> {mtime, size, ids}), ids: Map(word -> id), counts: number[] by id}
let index = null;

function idOf(word) {
  let id = index.ids.get(word);
  if (id === undefined) {
    id = index.counts.length;
    // A copy: the match is a slice that would keep the whole file's text alive.
    index.ids.set(Buffer.from(word).toString(), id);
    index.counts.push(0);
  }
  return id;
}

function forget(entry) {
  for (const id of entry.ids) index.counts[id]--;
}

function learn(text) {
  const seen = new Set();
  for (const m of text.matchAll(WORD)) seen.add(m[0]);
  const ids = new Uint32Array(seen.size);
  let i = 0;
  for (const w of seen) {
    const id = idOf(w);
    index.counts[id]++;
    ids[i++] = id;
  }
  return ids;
}

async function refresh(root) {
  if (index?.root !== root) index = { root, epoch: null, files: new Map(), ids: new Map(), counts: [] };
  const live = new Set(pyFiles(root));
  for (const [p, entry] of index.files) if (!live.has(p)) { forget(entry); index.files.delete(p); }
  const queue = [...live];
  const work = async () => {
    for (let p; (p = queue.pop());) {
      let st;
      try { st = await fs.promises.stat(p); } catch { continue; }
      const old = index.files.get(p);
      if (old && old.mtime === st.mtimeMs && old.size === st.size) continue;
      if (old) { forget(old); index.files.delete(p); }
      if (st.size > MAX_SIZE) continue;
      let text;
      try { text = (await fs.promises.readFile(p)).toString('utf8'); } catch { continue; }
      index.files.set(p, { mtime: st.mtimeMs, size: st.size, ids: learn(text) });
    }
  };
  await Promise.all(Array.from({ length: PARALLEL }, work));
}

// -> {files: number of indexed files, counts: {name: number of files mentioning it}}
async function fileCounts(root, names, epoch) {
  if (index?.root !== root || index.epoch !== epoch) {
    await refresh(root);
    index.epoch = epoch;
  }
  const counts = {};
  for (const n of names) counts[n] = index.counts[index.ids.get(n)] || 0;
  return { files: index.files.size, counts };
}

if (!isMainThread && workerData?.role === 'pyide-code-vision') {
  const OPS = { fileCounts };
  let chain = Promise.resolve();
  parentPort.on('message', ({ id, op, args }) => {
    chain = chain.then(() => OPS[op](...args))
      .then((result) => parentPort.postMessage({ id, result }), (e) => parentPort.postMessage({ id, error: e.message, code: e.code }));
  });
}

const worker = isMainThread ? require('../worker-host').fileWorker(__filename, 'pyide-code-vision') : null;

exports.register = ({ ipcMain }) => {
  // epoch: changes whenever Python files may have changed on disk; the index checks them again only then.
  ipcMain.handle('code-vision:fileCounts', (_e, root, names, epoch) => worker('fileCounts', root, names, epoch));
};
