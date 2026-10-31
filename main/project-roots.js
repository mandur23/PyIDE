// PyCharm's Mark Directory As: per project, the folders marked Sources Root, Test Sources Root and Excluded, as paths
// relative to the project root, kept in <userData>/project-roots.json (like run configurations, never in the project).
// Run, the test runner and frameworks put the source roots on PYTHONPATH (features/run.js withPath) and Pyright gets
// them as extraPaths (features/lsp.js), so the editor and the runtime resolve imports alike. The Mark Directory As UI
// is the project-roots plugin (features/project-roots.js, renderer/features/project-roots).
// A project without a record gets the src layout's root: src/ without an __init__.py, holding Python code, is a
// source root (Pyright's autoSearchPaths rule, narrowed to a src that holds code). The renderer's project-roots:get
// writes that down the first time (adoptDetected), to say so; from then on the record is what counts.
const fs = require('fs');
const path = require('path');

const KINDS = ['sources', 'tests', 'excluded'];
const keyOf = (root) => path.resolve(root).toLowerCase();
const listeners = new Set();
let store = null; // {root key: {sources: [rel], tests: [rel], excluded: [rel]}}
let storeStamp = null; // mtime of the file store was read from: another Nano Studio on the same user data may write it

const storeFile = () => {
  let dir;
  try { dir = require('electron').app.getPath('userData'); } catch { dir = process.env.PYIDE_USER_DATA; }
  return dir ? path.join(dir, 'project-roots.json') : null;
};

const relList = (v) => (Array.isArray(v) ? [...new Set(v.filter((r) => typeof r === 'string' && !path.isAbsolute(r) && !r.split(/[\\/]/).includes('..')))] : []);
const clean = (rec) => Object.fromEntries(KINDS.map((k) => [k, relList(rec?.[k])]));

function load() {
  const file = storeFile();
  let stamp = null;
  try { stamp = file && fs.statSync(file).mtimeMs; } catch {}
  if (store && stamp === storeStamp) return store;
  store = {};
  storeStamp = stamp;
  try {
    const saved = stamp && JSON.parse(fs.readFileSync(file, 'utf8'));
    if (saved && typeof saved === 'object' && !Array.isArray(saved)) for (const [k, v] of Object.entries(saved)) store[k] = clean(v);
  } catch {}
  return store;
}

function save() {
  const file = storeFile();
  if (!file) return;
  const tmp = `${file}.${process.pid}.tmp`;
  try {
    fs.mkdirSync(path.dirname(file), { recursive: true });
    fs.writeFileSync(tmp, JSON.stringify(store, null, 1));
    fs.renameSync(tmp, file);
    storeStamp = fs.statSync(file).mtimeMs;
  } catch { try { fs.rmSync(tmp, { force: true }); } catch {} }
}

const isPython = (name) => /\.pyi?$/i.test(name);
const entries = (dir) => { try { return fs.readdirSync(dir, { withFileTypes: true }); } catch { return []; } };
// Folders that hold no code of the project: build leftovers, caches, dot folders (Pyright skips the last three too).
const skipped = (name) => name.startsWith('.') || name === '__pycache__' || name === 'node_modules' || name.endsWith('.egg-info');
// Breadth first through dir and its folders (not skipped ones), the first `budget` of them. visit(dir, entries) returns
// 'stop' to end the walk (walkFolders then returns true), 'prune' not to go below dir, or nothing.
function walkFolders(dir, budget, visit) {
  const queue = [dir];
  for (let n = 0; n < queue.length && n < budget; n++) {
    const list = entries(queue[n]);
    const next = visit(queue[n], list);
    if (next === 'stop') return true;
    if (next !== 'prune') for (const d of list) if (d.isDirectory() && !skipped(d.name)) queue.push(path.join(queue[n], d.name));
  }
  return false;
}
// src/ is the root of a src layout when it is no package itself and holds Python code: a module, a package, or a
// namespace package (folders without __init__.py, such as src/acme/tools/helper.py). Pyright's own rule (any src
// without __init__.py) is narrowed to a src holding code within its first 200 folders, so a web project's src is left alone.
function srcLayout(root) {
  const src = path.join(root, 'src');
  const top = entries(src);
  if (!top.length || top.some((d) => d.isFile() && d.name === '__init__.py')) return false;
  return walkFolders(src, 200, (_dir, list) => (list.some((d) => d.isFile() && isPython(d.name)) ? 'stop' : null));
}

// The virtualenvs in the project (Pyright's markers: pyvenv.cfg, conda-meta, Scripts/activate, bin/activate), four
// levels down at most and not inside excluded folders. Pyright leaves them out of its files by itself only while no
// `exclude` is set (autoExcludeVenv), so features/lsp.js adds them to the excluded folders it sends.
function venvDirs(root) {
  const excluded = new Set(excludedDirs(root).map((d) => d.toLowerCase()));
  const top = path.resolve(root);
  const depth = (dir) => path.relative(top, dir).split(path.sep).length;
  const found = [];
  walkFolders(top, 2000, (dir, list) => {
    if (dir === top) return null;
    if (excluded.has(dir.toLowerCase())) return 'prune';
    const has = (name, isDir) => list.some((d) => d.name.toLowerCase() === name && (isDir ? d.isDirectory() : true));
    const activate = (sub) => has(sub, true) && entries(path.join(dir, sub)).some((d) => d.name.toLowerCase() === 'activate');
    if (has('pyvenv.cfg') || has('conda-meta', true) || activate('scripts') || activate('bin')) {
      found.push(dir);
      return 'prune';
    }
    return depth(dir) >= 4 ? 'prune' : null;
  });
  return found;
}

// The project's roots: its record, or the src layout's default. -> {sources, tests, excluded} (relative paths)
function rootsOf(root) {
  if (!root) return clean(null);
  const rec = load()[keyOf(root)];
  if (rec) return clean(rec);
  return { ...clean(null), sources: srcLayout(root) ? ['src'] : [] };
}

const abs = (root, rels) => rels.map((r) => path.resolve(root, r));
// Folders to put on sys.path for code of this project: the source roots, then the test source roots (absolute).
const pythonPaths = (root) => { const r = rootsOf(root); return abs(root, [...r.sources, ...r.tests]); };
const excludedDirs = (root) => abs(root, rootsOf(root).excluded);
// The roots a launcher puts on PYTHONPATH (the project root) followed by their source roots, without repeats.
function withSources(roots = []) {
  const seen = new Set();
  return roots.flatMap((r) => (r ? [r, ...pythonPaths(r)] : [])).filter((p) => !seen.has(p.toLowerCase()) && seen.add(p.toLowerCase()));
}

// Marks folder (absolute, inside root) as kind ('sources' | 'tests' | 'excluded') or unmarks it (kind null). A folder
// has one kind at a time, as in PyCharm; the project root itself cannot be excluded. -> the new roots, or null.
function mark(root, folder, kind) {
  if (kind !== null && !KINDS.includes(kind)) return null;
  const rel = path.relative(path.resolve(root), path.resolve(root, folder));
  if (rel.startsWith('..') || path.isAbsolute(rel) || (kind === 'excluded' && !rel)) return null;
  const r = rootsOf(root);
  for (const k of KINDS) r[k] = r[k].filter((x) => x.toLowerCase() !== rel.toLowerCase());
  if (kind) r[kind].push(rel);
  set(root, r);
  return r;
}

function set(root, rec) {
  load()[keyOf(root)] = clean(rec);
  save();
  for (const fn of listeners) { try { fn(root); } catch {} }
}

// fn(root) after a project's roots changed (lsp.js sends Pyright its new settings).
const onChange = (fn) => { listeners.add(fn); return () => listeners.delete(fn); };

// A project without a record whose src layout gives it a root gets that as its record now. -> 'src', or null.
function adoptDetected(root) {
  if (!root || load()[keyOf(root)]) return null;
  const r = rootsOf(root);
  if (!r.sources.length) return null;
  set(root, r);
  return 'src';
}

Object.assign(exports, { rootsOf, pythonPaths, excludedDirs, venvDirs, withSources, mark, onChange, srcLayout, adoptDetected });
