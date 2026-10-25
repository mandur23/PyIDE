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
let storeStamp = null; // mtime of the file store was read from: another PyIDE on the same user data may write it

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
// src/ is the root of a src layout when it is no package itself and holds a module or a folder of Python code (a
// package, or a namespace package without __init__.py). Build leftovers (*.egg-info, __pycache__, dot folders) do not count.
function srcLayout(root) {
  const src = path.join(root, 'src');
  const list = entries(src);
  if (!list.length || list.some((d) => d.isFile() && d.name === '__init__.py')) return false;
  return list.some((d) => (d.isFile() ? isPython(d.name)
    : d.isDirectory() && !d.name.startsWith('.') && d.name !== '__pycache__' && !d.name.endsWith('.egg-info')
      && entries(path.join(src, d.name)).some((e) => e.isFile() && isPython(e.name))));
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

Object.assign(exports, { rootsOf, pythonPaths, excludedDirs, withSources, mark, onChange, srcLayout, adoptDetected });
