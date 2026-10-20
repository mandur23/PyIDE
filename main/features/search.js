// Search and navigation backend: find/replace in files, TODO scan, and ast-based outline and symbol index.
const fs = require('fs');
const path = require('path');
const { spawn } = require('child_process');
const { Worker, isMainThread, parentPort, workerData } = require('worker_threads');

const SKIP_DIRS = new Set(['.git', '.hg', '.svn', '__pycache__', 'node_modules', '.idea', '.mypy_cache', '.pytest_cache',
  '.ruff_cache', '.tox', '.nox', '.venv', 'venv', 'env', 'site-packages']);
const MAX_SIZE = 2 * 1024 * 1024;
const MAX_MATCHES = 5000;
const MAX_FILES = 20000;
const PY_EXT = /\.py[iw]?$/i;

function walk(root, onFile) {
  let n = 0;
  const visit = (dir) => {
    let entries;
    try { entries = fs.readdirSync(dir, { withFileTypes: true }); } catch { return; }
    // A directory holding pyvenv.cfg is a virtualenv whatever its name.
    if (dir !== root && entries.some((d) => d.name === 'pyvenv.cfg')) return;
    for (const d of entries) {
      if (n >= MAX_FILES) return;
      const p = path.join(dir, d.name);
      if (d.isDirectory()) { if (!SKIP_DIRS.has(d.name)) visit(p); } else if (d.isFile()) { n++; if (onFile(p) === false) { n = MAX_FILES; return; } }
    }
  };
  visit(root);
}

// Text that is not UTF-8 is read as CP949 (EUC-KR), as the editor does (main/text-codec.js, which this file cannot
// require when it runs as the worker), so Korean text in such a file is found and the columns match the editor.
const UTF8 = new TextDecoder('utf-8', { fatal: true });
const CP949 = new TextDecoder('euc-kr');
const isUtf8 = (buf) => { try { UTF8.decode(buf); return true; } catch { return false; } };

// Returns null for files that are too large or look binary.
function readText(p) {
  let buf;
  try {
    if (fs.statSync(p).size > MAX_SIZE) return null;
    buf = fs.readFileSync(p);
  } catch { return null; }
  if (buf.subarray(0, 8000).includes(0)) return null;
  const text = isUtf8(buf) ? buf.toString('utf8') : CP949.decode(buf);
  return text.charCodeAt(0) === 0xfeff ? text.slice(1) : text;
}

const escapeRe = (s) => s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');

function buildRegex({ query, caseSensitive, words, regex }) {
  let src = regex ? query : escapeRe(query);
  if (words) src = regex ? `\\b(?:${src})\\b` : `${/^\w/.test(query) ? '\\b' : ''}${src}${/\w$/.test(query) ? '\\b' : ''}`;
  return new RegExp(src, `gm${caseSensitive ? '' : 'i'}`);
}

// PyCharm's replacement syntax: $1 groups and \n, \t escapes in regex mode, literal text otherwise.
const replacementOf = (opts) => (opts.regex
  ? (opts.replacement || '').replace(/\\([nt\\])/g, (_m, c) => (c === 'n' ? '\n' : c === 't' ? '\t' : '\\'))
  : (opts.replacement || '').replace(/\$/g, '$$$$'));

function maskMatcher(mask) {
  const parts = (mask || '').split(/[,;]/).map((s) => s.trim()).filter(Boolean);
  const toRe = (g) => new RegExp(`^${g.split('*').map((s) => s.split('?').map(escapeRe).join('.')).join('.*')}$`, 'i');
  const pos = parts.filter((s) => !s.startsWith('!')).map(toRe);
  const neg = parts.filter((s) => s.startsWith('!')).map((s) => toRe(s.slice(1)));
  return (p) => {
    const name = path.basename(p);
    return (!pos.length || pos.some((r) => r.test(name))) && !neg.some((r) => r.test(name));
  };
}

function lineStarts(text) {
  const starts = [0];
  for (let i = text.indexOf('\n'); i >= 0; i = text.indexOf('\n', i + 1)) starts.push(i + 1);
  return starts;
}

function lineOf(starts, offset) {
  let lo = 0;
  let hi = starts.length - 1;
  while (lo < hi) {
    const mid = (lo + hi + 1) >> 1;
    if (starts[mid] <= offset) lo = mid; else hi = mid - 1;
  }
  return lo;
}

// A match as the UI shows it: 1-based line/col, length clipped to the line, and a preview window of that line.
function describe(text, starts, index, length) {
  const li = lineOf(starts, index);
  const ls = starts[li];
  let le = li + 1 < starts.length ? starts[li + 1] - 1 : text.length;
  if (text[le - 1] === '\r') le--;
  const col = index - ls;
  const len = Math.max(0, Math.min(length, le - index));
  let from = 0;
  let line = text.slice(ls, le);
  if (line.length > 240) {
    from = Math.max(0, col - 80);
    line = line.slice(from, from + 240);
  }
  return { line: li + 1, col: col + 1, len, text: line, start: col - from, end: col - from + len, clipped: from > 0 };
}

function findIn(text, re, limit) {
  const out = [];
  let starts;
  re.lastIndex = 0;
  for (let m = re.exec(text); m && out.length < limit; m = re.exec(text)) {
    if (m[0].length === 0) { re.lastIndex++; continue; }
    starts ??= lineStarts(text);
    out.push(describe(text, starts, m.index, m[0].length));
  }
  return out;
}

const lowerMap = (obj) => new Map(Object.entries(obj || {}).map(([k, v]) => [k.toLowerCase(), v]));

function find(root, opts, overrides) {
  if (!opts.query) return { files: [], count: 0 };
  let re;
  try { re = buildRegex(opts); } catch (e) { return { error: e.message.replace(/^Invalid regular expression: \/.*\/[a-z]*: /, ''), files: [], count: 0 }; }
  const accept = maskMatcher(opts.mask);
  const ov = lowerMap(overrides);
  const files = [];
  let count = 0;
  let truncated = false;
  walk(opts.dir || root, (p) => {
    if (!accept(p)) return;
    const text = ov.get(p.toLowerCase()) ?? readText(p);
    if (text == null) return;
    const matches = findIn(text, re, MAX_MATCHES - count);
    if (!matches.length) return;
    files.push({ path: p, matches });
    count += matches.length;
    if (count >= MAX_MATCHES) { truncated = true; return false; }
  });
  files.sort((a, b) => a.path.localeCompare(b.path));
  return { files, count, truncated };
}

// String.prototype.replace's $-pattern expansion (GetSubstitution) for a replace() callback's arguments.
function expandReplacement(rep, args) {
  const a = [...args];
  const groups = typeof a[a.length - 1] === 'string' ? undefined : a.pop();
  const str = a.pop();
  const pos = a.pop();
  const [match, ...caps] = a;
  return rep.replace(/\$(\$|&|`|'|\d{1,2}|<([^>]*)>)/g, (t, k, name) => {
    if (k === '$') return '$';
    if (k === '&') return match;
    if (k === '`') return str.slice(0, pos);
    if (k === "'") return str.slice(pos + match.length);
    if (name !== undefined) return groups ? groups[name] ?? '' : t;
    if (k.length === 2 && Number(k) >= 1 && Number(k) <= caps.length) return caps[Number(k) - 1] ?? '';
    const n = Number(k[0]);
    return n >= 1 && n <= caps.length ? (caps[n - 1] ?? '') + k.slice(1) : t;
  });
}

// Replaces exactly the matches findIn reports: empty matches are skipped there, so they must be here too, or a regex
// like `a*` would also insert the replacement at every gap of the file while the preview counted one match.
function replaceText(text, re, rep) {
  let count = 0;
  re.lastIndex = 0;
  const next = text.replace(re, (...args) => {
    if (args[0] === '') return '';
    count++;
    return expandReplacement(rep, args);
  });
  return { text: next, count };
}

// UTF-8 files only; the others are returned as `foreign` for the main side to rewrite in their own encoding.
function replaceIn(paths, opts) {
  const re = buildRegex(opts);
  const rep = replacementOf(opts);
  const changed = [];
  const foreign = [];
  let count = 0;
  for (const p of paths) {
    let raw;
    try { if (fs.statSync(p).size > MAX_SIZE) continue; raw = fs.readFileSync(p); } catch { continue; }
    if (raw.subarray(0, 8000).includes(0)) continue;
    if (!isUtf8(raw)) { foreign.push(p); continue; }
    const text = raw.toString('utf8');
    const { text: next, count: n } = replaceText(text, re, rep);
    if (!n || next === text) continue;
    fs.writeFileSync(p, next, 'utf8');
    changed.push(p);
    count += n;
  }
  return { changed, count, foreign };
}

const COMMENT = { js: '//', ts: '//', jsx: '//', tsx: '//', java: '//', c: '//', h: '//', cpp: '//', go: '//', rs: '//', kt: '//', swift: '//' };
const HASH_EXT = new Set(['py', 'pyi', 'pyw', 'sh', 'ps1', 'toml', 'yaml', 'yml', 'cfg', 'ini', 'rb', 'pl', 'r']);

// PyCharm's default TODO patterns (\btodo\b.*, \bfixme\b.*), matched inside comments only.
function todoItems(text, marker) {
  if (text == null || !/todo|fixme/i.test(text)) return [];
  const re = new RegExp(`${escapeRe(marker)}.*?\\b(todo|fixme)\\b.*$`, 'gimd');
  let starts;
  const items = [];
  for (let m = re.exec(text); m; m = re.exec(text)) {
    starts ??= lineStarts(text);
    const [kwStart] = m.indices[1];
    const end = m.index + m[0].replace(/\r$/, '').length;
    const d = describe(text, starts, kwStart, end - kwStart);
    items.push({ line: d.line, col: d.col, text: text.slice(kwStart, end).trim(), kind: m[1].toUpperCase(), kwLen: m[1].length });
  }
  return items;
}

// pathLower -> {mtime, size, items}. The TODO list is rescanned on every save and file change, so a rescan rereads
// only files whose mtime or size moved; unsaved buffers (overrides) always count fresh.
const todoCache = new Map();

function todos(root, overrides) {
  const ov = lowerMap(overrides);
  const files = [];
  let count = 0;
  walk(root, (p) => {
    const ext = path.extname(p).slice(1).toLowerCase();
    const marker = COMMENT[ext] || (HASH_EXT.has(ext) ? '#' : null);
    if (!marker) return;
    const key = p.toLowerCase();
    let items;
    if (ov.has(key)) items = todoItems(ov.get(key), marker);
    else {
      let st;
      try { st = fs.statSync(p); } catch { return; }
      const hit = todoCache.get(key);
      if (hit && hit.mtime === st.mtimeMs && hit.size === st.size) items = hit.items;
      else {
        items = todoItems(readText(p), marker);
        todoCache.set(key, { mtime: st.mtimeMs, size: st.size, items });
      }
    }
    if (items.length) { files.push({ path: p, items }); count += items.length; }
    if (count >= 5000) return false;
  });
  files.sort((a, b) => a.path.localeCompare(b.path));
  return { files, count };
}

// Python files under root with their mtime, for the symbol index.
function pyFiles(root) {
  const out = [];
  walk(root, (p) => {
    if (!PY_EXT.test(p)) return;
    try { const st = fs.statSync(p); if (st.size <= MAX_SIZE) out.push({ p, mtime: st.mtimeMs }); } catch {}
  });
  return out;
}

function invalidateScans(paths) {
  if (!paths) todoCache.clear();
  else for (const p of paths) todoCache.delete(String(p).toLowerCase());
}

// File scans run on a worker thread: on a large project they read thousands of files, and doing that on the main
// process froze every window and IPC call until it finished.
const SCANS = { find, replace: (paths, opts) => replaceIn(paths, opts), todos, pyFiles, invalidate: invalidateScans };
if (!isMainThread && workerData?.role === 'pyide-search') {
  parentPort.on('message', ({ id, op, args }) => {
    try { parentPort.postMessage({ id, result: SCANS[op](...args) }); } catch (e) { parentPort.postMessage({ id, error: e.message }); }
  });
}

// Main side; worker-host evaluates this file as the worker (the role check above).
const scan = isMainThread ? require('../worker-host').fileWorker(__filename, 'pyide-search') : null;
const textCodec = isMainThread ? require('../text-codec') : null;

// Replaces in the files the worker left alone (CP949 and other non-UTF-8 text), keeping their encoding.
function replaceForeign(paths, opts) {
  const changed = [];
  let count = 0;
  for (const p of paths) {
    try {
      const file = textCodec.read(p);
      if (file.text === undefined) continue;
      const { text, count: n } = replaceText(file.text, buildRegex(opts), replacementOf(opts));
      if (!n || text === file.text) continue;
      textCodec.write(p, text, file.encoding);
      changed.push(p);
      count += n;
    } catch {}
  }
  return { changed, count };
}

// The Find in Files dialog searches as the user types, and every search reads the whole project on the worker, one
// after another. A preview search (`live`) therefore waits only behind the one running: a newer preview replaces it,
// and the replaced one answers {superseded: true} at once instead of scanning the project for text nobody sees.
let liveBusy = false;
let liveNext = null;
function liveFind(args) {
  return new Promise((resolve, reject) => {
    liveNext?.resolve({ files: [], count: 0, superseded: true });
    liveNext = { args, resolve, reject };
    pumpLive();
  });
}
function pumpLive() {
  if (liveBusy || !liveNext) return;
  const { args, resolve, reject } = liveNext;
  liveNext = null;
  liveBusy = true;
  scan('find', ...args).then(resolve, reject).finally(() => { liveBusy = false; pumpLive(); });
}

// One script, two modes: `outline` parses source from stdin into a tree; `index` reads a JSON list of paths and returns flat symbols per file.
const AST_SCRIPT = String.raw`
import ast, sys, json

def unparse(n):
    try:
        return ast.unparse(n)
    except Exception:
        return ''

def sig(fn):
    s = '(' + unparse(fn.args) + ')'
    if fn.returns is not None:
        s += ' -> ' + unparse(fn.returns)
    return s

def names(t):
    if isinstance(t, ast.Name):
        yield t
    elif isinstance(t, (ast.Tuple, ast.List)):
        for e in t.elts:
            yield from names(e)
    elif isinstance(t, ast.Starred):
        yield from names(t.value)

def outline(tree, lines):
    def col_of(node, name):
        line = lines[node.lineno - 1] if 0 < node.lineno <= len(lines) else ''
        i = line.find(name, node.col_offset)
        return (i if i >= 0 else node.col_offset) + 1

    def item(kind, name, node, detail='', children=None, col=None):
        return {'name': name, 'kind': kind, 'line': node.lineno, 'col': col or col_of(node, name),
                'endLine': getattr(node, 'end_lineno', None) or node.lineno, 'detail': detail, 'children': children or []}

    def deco_names(fn):
        for d in fn.decorator_list:
            d = d.func if isinstance(d, ast.Call) else d
            yield d.id if isinstance(d, ast.Name) else getattr(d, 'attr', '')

    def instance_fields(cls, known):
        out = []
        for fn in cls.body:
            if not isinstance(fn, (ast.FunctionDef, ast.AsyncFunctionDef)) or not fn.args.args:
                continue
            me = fn.args.args[0].arg
            for n in ast.walk(fn):
                tgts = n.targets if isinstance(n, ast.Assign) else [n.target] if isinstance(n, (ast.AnnAssign, ast.AugAssign)) else []
                for t in tgts:
                    if isinstance(t, ast.Attribute) and isinstance(t.value, ast.Name) and t.value.id == me and t.attr not in known:
                        known.add(t.attr)
                        ann = ': ' + unparse(n.annotation) if isinstance(n, ast.AnnAssign) else ''
                        out.append(item('field', t.attr, t, ann, col=t.end_col_offset - len(t.attr) + 1))
        return out

    def body(stmts, scope, seen=None):
        out = []
        seen = set() if seen is None else seen
        for s in stmts:
            if isinstance(s, ast.ClassDef):
                bases = ', '.join(unparse(b) for b in s.bases)
                out.append(item('class', s.name, s, '(' + bases + ')' if bases else '', class_body(s)))
            elif isinstance(s, (ast.FunctionDef, ast.AsyncFunctionDef)):
                kind = 'function'
                if scope == 'class':
                    kind = 'property' if set(deco_names(s)) & {'property', 'cached_property', 'setter', 'getter'} else 'method'
                if kind == 'property' and any(c['name'] == s.name and c['kind'] == 'property' for c in out):
                    continue
                out.append(item(kind, s.name, s, sig(s), body(s.body, 'function')))
            elif scope != 'function' and isinstance(s, (ast.Assign, ast.AnnAssign)):
                tgts = s.targets if isinstance(s, ast.Assign) else [s.target]
                ann = ': ' + unparse(s.annotation) if isinstance(s, ast.AnnAssign) else ''
                for t in tgts:
                    for n in names(t):
                        if n.id in seen:
                            continue
                        seen.add(n.id)
                        out.append(item('field' if scope == 'class' else 'variable', n.id, n, ann, col=n.col_offset + 1))
            elif scope != 'function' and isinstance(s, (ast.If, ast.Try, ast.With, ast.For, ast.While)) or type(s).__name__ == 'TryStar':
                nested = list(getattr(s, 'body', [])) + list(getattr(s, 'orelse', [])) + list(getattr(s, 'finalbody', []))
                for h in getattr(s, 'handlers', []):
                    nested += h.body
                out += body(nested, scope, seen)
        return out

    def class_body(cls):
        known = set()
        items = body(cls.body, 'class', known)
        extra = instance_fields(cls, known)
        first_def = next((i for i, c in enumerate(items) if c['kind'] not in ('field',)), len(items))
        return items[:first_def] + extra + items[first_def:]

    return body(tree.body, 'module')

def flatten(items, container, out):
    for it in items:
        out.append({'name': it['name'], 'kind': it['kind'], 'line': it['line'], 'col': it['col'], 'container': container})
        if it['kind'] == 'class':
            flatten(it['children'], it['name'], out)
        elif it['kind'] in ('function', 'method'):
            flatten([c for c in it['children'] if c['kind'] in ('class', 'function')], it['name'], out)
    return out

mode = sys.argv[1]
if mode == 'outline':
    src = sys.stdin.buffer.read().decode('utf-8', 'replace')
    try:
        tree = ast.parse(src)
        print(json.dumps({'items': outline(tree, src.splitlines())}))
    except SyntaxError as e:
        print(json.dumps({'error': e.msg, 'line': e.lineno or 1}))
else:
    result = {}
    for p in json.loads(sys.stdin.buffer.read().decode('utf-8')):
        try:
            with open(p, 'rb') as f:
                src = f.read().decode('utf-8', 'replace')
            result[p] = flatten(outline(ast.parse(src), src.splitlines()), '', [])
        except Exception:
            result[p] = []
    print(json.dumps(result))
`;

function runAst(interp, mode, input) {
  return new Promise((resolve) => {
    let p;
    try { p = spawn(interp.cmd, [...interp.args, '-c', AST_SCRIPT, mode], { windowsHide: true }); } catch { return resolve(null); }
    let out = '';
    p.stdout.on('data', (d) => (out += d));
    p.on('error', () => resolve(null));
    p.on('close', () => { try { resolve(JSON.parse(out)); } catch { resolve(null); } });
    p.stdin.on('error', () => {});
    p.stdin.end(input, 'utf8');
  });
}

// pathLower -> {path, mtime, symbols}; entries are dropped by search:invalidate and refreshed by mtime.
const symbolCache = new Map();
let indexQueue = Promise.resolve();

async function buildIndex(interp, root) {
  const live = new Set();
  const stale = [];
  for (const { p, mtime } of await scan('pyFiles', root)) {
    const key = p.toLowerCase();
    live.add(key);
    const hit = symbolCache.get(key);
    if (!hit || hit.mtime !== mtime) stale.push({ p, mtime });
  }
  for (let i = 0; i < stale.length; i += 400) {
    const batch = stale.slice(i, i + 400);
    const res = (await runAst(interp, 'index', JSON.stringify(batch.map((b) => b.p)))) || {};
    for (const { p, mtime } of batch) symbolCache.set(p.toLowerCase(), { path: p, mtime, symbols: res[p] || [] });
  }
  // With the separator, so indexing C:\proj does not drop the cached files of C:\proj2.
  const rootKey = root.toLowerCase().replace(/[\\/]*$/, path.sep);
  const out = [];
  for (const [key, entry] of symbolCache) {
    if (!key.startsWith(rootKey)) continue;
    if (!live.has(key)) { symbolCache.delete(key); continue; }
    for (const s of entry.symbols) out.push({ ...s, path: entry.path });
  }
  return out;
}

exports.register = ({ ipcMain }) => {
  ipcMain.handle('search:find', (_e, root, opts, overrides, { live } = {}) => (live ? liveFind([root, opts, overrides]) : scan('find', root, opts, overrides)));
  ipcMain.handle('search:replace', async (_e, opts, paths) => {
    const { changed, count, foreign } = await scan('replace', paths, opts);
    const other = replaceForeign(foreign, opts);
    return { changed: [...changed, ...other.changed], count: count + other.count };
  });
  // The same replacement applied to an unsaved buffer's text -> {text, count}.
  ipcMain.handle('search:replaceText', (_e, opts, text) => replaceText(text, buildRegex(opts), replacementOf(opts)));
  ipcMain.handle('search:todos', (_e, root, overrides) => scan('todos', root, overrides));
  ipcMain.handle('search:outline', async (_e, interp, text) => (await runAst(interp, 'outline', text)) || { error: 'Python interpreter failed' });
  ipcMain.handle('search:symbols', (_e, interp, root) => {
    const run = indexQueue.then(() => buildIndex(interp, root));
    indexQueue = run.catch(() => {});
    return run;
  });
  ipcMain.handle('search:invalidate', (_e, paths) => {
    if (!paths) symbolCache.clear();
    else for (const p of paths) symbolCache.delete(String(p).toLowerCase());
    return scan('invalidate', paths || null);
  });
};
