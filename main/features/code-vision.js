// How many of the project's Python files mention a name, for code vision's usage counts
// (renderer/features/code-vision), and which files spell a name in a class statement's bases, for the type-hierarchy
// gutter markers (main/features/type-hierarchy.js). Pyright's references request parses and binds every project file
// whose text holds the name, so counting a name found in thousands of files took 15 s of Pyright's only request thread
// and grew it by 2 GB; code vision asks this first and counts such names only on click, and the gutter markers look
// for subclasses only in the files named here. A worker keeps a word -> number of files index of the project's
// .py/.pyi files (folders marked Excluded left out, main/project-roots.js), and checks each file's mtime and size
// again when a renderer says files changed (an `epoch` it has not sent before).
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
const WORD = /[A-Za-z_\u00aa-\uffff][\w\u00aa-\uffff]*/g;
const CLASS = /^[ \t]*class[ \t]+[A-Za-z_\u00aa-\uffff][\w\u00aa-\uffff]*/gm;
const NOT_A_BASE = /^\s*(?:\*|[\w\u00aa-\uffff]+\s*=(?!=))/;
// A class statement's bases end within this many characters (an unclosed parenthesis does not scan the rest of the file).
const MAX_BASES = 2000;

// excluded: the folders marked Excluded (absolute), compared without case as search.js's walk does.
function pyFiles(root, excluded) {
  const out = [];
  const skipped = new Set(excluded.map((d) => d.toLowerCase()));
  const visit = (dir) => {
    let entries;
    try { entries = fs.readdirSync(dir, { withFileTypes: true }); } catch { return; }
    if (dir !== root && entries.some((d) => d.name === 'pyvenv.cfg')) return;
    for (const d of entries) {
      if (out.length >= MAX_FILES) return;
      const p = path.join(dir, d.name);
      if (d.isDirectory()) { if (!SKIP_DIRS.has(d.name) && !skipped.has(p.toLowerCase())) visit(p); } else if (d.isFile() && PY.test(d.name)) out.push(p);
    }
  };
  visit(root);
  return out;
}

// The words of every class statement's bases outside brackets (`class A(pkg.Base[T], metaclass=M)` gives pkg and
// Base): the base names and more, never fewer, since the renderer checks each candidate with Pyright.
function baseWords(text) {
  const out = new Set();
  for (const m of text.matchAll(CLASS)) {
    let i = m.index + m[0].length;
    const end = Math.min(text.length, i + MAX_BASES);
    let depth = 0;
    let arg = '';
    const take = () => {
      if (!NOT_A_BASE.test(arg)) for (const w of arg.match(WORD) || []) out.add(w);
      arg = '';
    };
    while (text[i] === ' ' || text[i] === '\t') i++;
    if (text[i] === '[') { // PEP 695 type parameters
      for (; i < end; i++) if (text[i] === '[') depth++; else if (text[i] === ']' && --depth === 0) break;
      for (i++; text[i] === ' ' || text[i] === '\t'; i++);
    }
    if (text[i] !== '(') continue;
    depth = 0;
    for (i++; i < end; i++) {
      const c = text[i];
      if (c === '#') { while (i < end && text[i] !== '\n') i++; continue; }
      if (depth === 0 && (c === ',' || c === ')')) { take(); if (c === ')') break; continue; }
      if (c === '(' || c === '[' || c === '{') depth++;
      else if (c === ')' || c === ']' || c === '}') depth--;
      arg += depth === 0 && !')]}'.includes(c) ? c : ' ';
    }
  }
  return out;
}

// {root, key: the Excluded folders, epochs: those checked since, files: Map(path -> {mtime, size, ids, bases}),
// ids: Map(word -> id), counts: number[] by id}
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
  return { ids, bases: Uint32Array.from(baseWords(text), idOf) };
}

async function refresh(root, excluded) {
  const live = new Set(pyFiles(root, excluded));
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
      index.files.set(p, { mtime: st.mtimeMs, size: st.size, ...learn(text) });
    }
  };
  await Promise.all(Array.from({ length: PARALLEL }, work));
}

// Code vision and type hierarchy, in every window, spell their epochs each their own way, so the files are checked
// again for an epoch not seen before rather than whenever it differs from the last one asked with.
async function ensure(root, epoch, excluded) {
  const key = excluded.map((d) => d.toLowerCase()).sort().join('\n');
  if (index?.root !== root) index = { root, key, epochs: new Set(), files: new Map(), ids: new Map(), counts: [] };
  else if (index.key !== key) { index.key = key; index.epochs.clear(); }
  if (index.epochs.has(epoch)) return;
  await refresh(root, excluded);
  index.epochs.add(epoch);
}

// -> {files: number of indexed files, counts: {name: number of files mentioning it}}
async function fileCounts(root, names, epoch, excluded = []) {
  await ensure(root, epoch, excluded);
  const counts = {};
  for (const n of names) counts[n] = index.counts[index.ids.get(n)] || 0;
  return { files: index.files.size, counts };
}

// -> {name: [paths of the files whose class statements spell the name in their bases]}
async function subclassFiles(root, names, epoch, excluded = []) {
  await ensure(root, epoch, excluded);
  const wanted = new Map();
  const out = {};
  for (const n of names) {
    out[n] = [];
    if (index.ids.has(n)) wanted.set(index.ids.get(n), n);
  }
  for (const [p, entry] of index.files) for (const id of entry.bases) if (wanted.has(id)) out[wanted.get(id)].push(p);
  return out;
}

if (!isMainThread && workerData?.role === 'pyide-code-vision') {
  const OPS = { fileCounts, subclassFiles };
  let chain = Promise.resolve();
  parentPort.on('message', ({ id, op, args }) => {
    chain = chain.then(() => OPS[op](...args))
      .then((result) => parentPort.postMessage({ id, result }), (e) => parentPort.postMessage({ id, error: e.message, code: e.code }));
  });
}

const worker = isMainThread ? require('../worker-host').fileWorker(__filename, 'pyide-code-vision') : null;
// The worker cannot read the user data the Excluded folders are kept in, so main passes them with each call.
const excludedOf = isMainThread ? require('../project-roots').excludedDirs : null;

// epoch: changes whenever Python files may have changed on disk; the index checks them again only then.
exports.fileCounts = (root, names, epoch) => worker('fileCounts', root, names, epoch, excludedOf(root));
exports.subclassFiles = (root, names, epoch) => worker('subclassFiles', root, names, epoch, excludedOf(root));
exports.register = ({ ipcMain }) => {
  ipcMain.handle('code-vision:fileCounts', (_e, root, names, epoch) => exports.fileCounts(root, names, epoch));
};
