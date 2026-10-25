// Search and navigation backend: find/replace in files, TODO scan, and ast-based outline and symbol index.
const fs = require('fs');
const crypto = require('crypto');
const os = require('os');
const path = require('path');
const { spawn } = require('child_process');
const { Worker, isMainThread, parentPort, workerData } = require('worker_threads');

const SKIP_DIRS = new Set(['.git', '.hg', '.svn', '__pycache__', 'node_modules', '.idea', '.mypy_cache', '.pytest_cache',
  '.ruff_cache', '.tox', '.nox', '.venv', 'venv', 'env', 'site-packages']);
const MAX_SIZE = 2 * 1024 * 1024;
const MAX_MATCHES = 5000;
const MAX_FILES = 20000;
const PY_EXT = /\.py[iw]?$/i;

// excluded: the folders marked Excluded (absolute; main/project-roots.js excludedDirs), compared without case as
// fs-scan.js does. A walk that starts inside one (Find in Files with that directory chosen) still searches it.
function walk(root, onFile, excluded = []) {
  let n = 0;
  const skipped = new Set(excluded.map((d) => d.toLowerCase()));
  const visit = (dir) => {
    let entries;
    try { entries = fs.readdirSync(dir, { withFileTypes: true }); } catch { return; }
    // A directory holding pyvenv.cfg is a virtualenv whatever its name.
    if (dir !== root && entries.some((d) => d.name === 'pyvenv.cfg')) return;
    for (const d of entries) {
      if (n >= MAX_FILES) return;
      const p = path.join(dir, d.name);
      if (d.isDirectory()) { if (!SKIP_DIRS.has(d.name) && !skipped.has(p.toLowerCase())) visit(p); } else if (d.isFile()) { n++; if (onFile(p) === false) { n = MAX_FILES; return; } }
    }
  };
  visit(root);
}

// Text that is not UTF-8 is read as CP949 (EUC-KR), as the editor does (main/text-codec.js, which this file cannot
// require when it runs as the worker), so Korean text in such a file is found and the columns match the editor.
const UTF8 = new TextDecoder('utf-8', { fatal: true });
const CP949 = new TextDecoder('euc-kr');
const isUtf8 = (buf) => { try { UTF8.decode(buf); return true; } catch { return false; } };

// UTF-16 text, with or without a byte order mark (PowerShell's `>` writes it): full of NUL bytes, yet text, and not
// UTF-8 even when its bytes happen to decode as UTF-8. Same test as text-codec.js. -> 'utf-16le' | 'utf-16be' | null
function utf16Of(buf) {
  if (buf[0] === 0xff && buf[1] === 0xfe) return 'utf-16le';
  if (buf[0] === 0xfe && buf[1] === 0xff) return 'utf-16be';
  if (buf.length < 2 || buf.length % 2) return null;
  const n = Math.min(buf.length, 8000);
  let le = 0;
  let be = 0;
  for (let i = 0; i < n; i += 2) {
    if (buf[i] === 0 && buf[i + 1] === 0) return null;
    if (buf[i + 1] === 0 && buf[i] >= 9 && buf[i] < 0x7f) le++;
    else if (buf[i] === 0 && buf[i + 1] >= 9 && buf[i + 1] < 0x7f) be++;
  }
  return le >= n / 6 && be <= le / 20 ? 'utf-16le' : be >= n / 6 && le <= be / 20 ? 'utf-16be' : null;
}
const UTF16 = new TextDecoder('utf-16le');
function decodeUtf16(buf, wide) {
  let b = buf.subarray((buf[0] === 0xff && buf[1] === 0xfe) || (buf[0] === 0xfe && buf[1] === 0xff) ? 2 : 0);
  b = b.subarray(0, b.length - (b.length % 2));
  return UTF16.decode(wide === 'utf-16be' ? Buffer.from(b).swap16() : b);
}

// null for bytes that look binary.
function decodeText(buf) {
  const wide = utf16Of(buf);
  if (wide) return decodeUtf16(buf, wide);
  if (buf.subarray(0, 8000).includes(0)) return null;
  let text;
  try { text = UTF8.decode(buf); } catch { text = CP949.decode(buf); }
  return text.charCodeAt(0) === 0xfeff ? text.slice(1) : text;
}

// Returns null for files that are too large or look binary.
function readText(p) {
  let buf;
  try {
    if (fs.statSync(p).size > MAX_SIZE) return null;
    buf = fs.readFileSync(p);
  } catch { return null; }
  return decodeText(buf);
}

// path -> {mtime, size, text}: what Find in Files read, so the next search (the dialog searches again at every pause
// in typing) reads only the files whose mtime or size changed. Each search stats every file instead of trusting the
// project watcher alone (search:invalidate), which can miss a change. Keyed by the path as walked: in a case-sensitive
// folder a.py and A.py are two entries. Oldest entries go first past TEXT_CACHE_MAX characters (UTF-16, so 64 MB).
const textCache = new Map();
const TEXT_CACHE_MAX = 32 * 1024 * 1024;
let textCacheChars = 0;

function forgetText(p) {
  const hit = textCache.get(p);
  if (!hit) return;
  textCache.delete(p);
  textCacheChars -= hit.text?.length || 0;
}

function rememberText(p, st, text) {
  forgetText(p);
  textCache.set(p, { mtime: st.mtimeMs, size: st.size, text });
  textCacheChars += text?.length || 0;
  for (const [old] of textCache) {
    if (textCacheChars <= TEXT_CACHE_MAX) break;
    forgetText(old);
  }
}

// Callback fs, and one read of the size stat gave: with fs.promises.readFile (five thread-pool round trips per file)
// a first search of 6,000 files took 5-15 s on the main process's worker in Electron, against 0.3-0.4 s this way.
const statOf = (p) => new Promise((resolve) => fs.stat(p, (e, st) => resolve(e ? null : st)));
const readOf = (p, size) => new Promise((resolve, reject) => fs.open(p, 'r', (e, fd) => {
  if (e) return reject(e);
  const buf = Buffer.allocUnsafe(size);
  fs.read(fd, buf, 0, size, 0, (err, n) => {
    fs.close(fd, () => {});
    if (err) reject(err); else resolve(n === size ? buf : buf.subarray(0, n));
  });
}));

async function cachedText(p) {
  const st = await statOf(p);
  if (!st) { forgetText(p); return null; }
  const hit = textCache.get(p);
  if (hit && hit.mtime === st.mtimeMs && hit.size === st.size) return hit.text;
  let text = null;
  if (st.size <= MAX_SIZE) {
    try { text = decodeText(await readOf(p, st.size)); } catch { forgetText(p); return null; }
  }
  rememberText(p, st, text);
  return text;
}

// Files are read this many ahead of the one being searched: one synchronous read at a time spent most of a search
// opening files (about 70 µs each on NTFS), and parallel reads overlap that.
const READ_AHEAD = 16;

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

// Monaco's isMultilineRegexSource: a pattern that can match a line break (\n, \r, \W, or a typed line break). The editor
// matches any other regex line by line, so `\s+$` trims each line instead of joining it with the next; Find and Replace
// in Files do the same, or a CRLF file's \r and its blank lines went with the trailing spaces.
function isMultiline({ query, regex }) {
  if (query.includes('\n')) return true;
  if (!regex) return false;
  for (let i = 0; i < query.length; i++) {
    if (query[i] === '\\' && ++i < query.length && 'nrW'.includes(query[i])) return true;
  }
  return false;
}

const compile = (opts) => ({ re: buildRegex(opts), rep: replacementOf(opts), perLine: !!opts.regex && !isMultiline(opts) });

// The text with each \r\n as \n, as the editor searches it, and crlf: the offsets in that text of the \n that were \r\n.
function normalized(text) {
  const crlf = [];
  if (!text.includes('\r\n')) return { flat: text, crlf };
  const parts = [];
  let from = 0;
  for (let i = text.indexOf('\r\n'); i >= 0; i = text.indexOf('\r\n', i + 2)) {
    parts.push(text.slice(from, i));
    crlf.push(i - crlf.length);
    from = i + 1;
  }
  parts.push(text.slice(from));
  return { flat: parts.join(''), crlf };
}

// The non-empty matches of `re` in text with \n line breaks: {m, index, str}, str being the text m was found in.
function* matchesOf(flat, re, perLine) {
  function* scan(str, base) {
    re.lastIndex = 0;
    for (let m = re.exec(str); m; m = re.exec(str)) {
      if (m[0].length === 0) { re.lastIndex++; continue; }
      yield { m, index: base + m.index, str };
    }
  }
  if (!perLine) { yield* scan(flat, 0); return; }
  for (let s = 0; s <= flat.length;) {
    let e = flat.indexOf('\n', s);
    if (e < 0) e = flat.length;
    yield* scan(flat.slice(s, e), s);
    s = e + 1;
  }
}

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

function findIn(text, { re, perLine }, limit) {
  const out = [];
  const { flat } = normalized(text);
  let starts;
  for (const { m, index } of matchesOf(flat, re, perLine)) {
    if (out.length >= limit) break;
    starts ??= lineStarts(flat);
    out.push(describe(flat, starts, index, m[0].length));
  }
  return out;
}

// main/path-case.js's pathKey with the case-sensitive folders passed in (`dirs`: their dirKeys), which the worker
// cannot require: the path in lower case, except the names inside those folders.
const dirKeyOf = (key) => key.replace(/[\\/]+/g, '\\').replace(/\\$/, '');
function pathKeyIn(p, dirs) {
  const lower = p.toLowerCase();
  if (!dirs.size) return lower;
  const parts = p.split(/([\\/]+)/);
  let key = '';
  for (let i = 0; i < parts.length; i += 2) key += (i && dirs.has(dirKeyOf(key)) ? parts[i] : parts[i].toLowerCase()) + (parts[i + 1] || '');
  return key;
}

// Unsaved texts as the main side sends them ({texts: {pathKey: text}, dirs}, see keyedOverrides) -> p => text | undefined.
function overrideOf(overrides) {
  const texts = new Map(Object.entries(overrides?.texts || {}));
  const dirs = new Set(overrides?.dirs || []);
  return (p) => (texts.size ? texts.get(pathKeyIn(p, dirs)) : undefined);
}

async function find(root, opts, overrides, excluded) {
  if (!opts.query) return { files: [], count: 0 };
  let c;
  try { c = compile(opts); } catch (e) { return { error: e.message.replace(/^Invalid regular expression: \/.*\/[a-z]*: /, ''), files: [], count: 0 }; }
  const accept = maskMatcher(opts.mask);
  const unsaved = overrideOf(overrides);
  const paths = [];
  walk(opts.dir || root, (p) => { if (accept(p)) paths.push(p); }, excluded);
  const texts = new Array(paths.length);
  let ahead = 0;
  const files = [];
  let count = 0;
  let truncated = false;
  for (let i = 0; i < paths.length; i++) {
    for (; ahead < paths.length && ahead < i + READ_AHEAD; ahead++) texts[ahead] = unsaved(paths[ahead]) ?? cachedText(paths[ahead]);
    const text = await texts[i];
    texts[i] = undefined;
    if (text == null) continue;
    const matches = findIn(text, c, MAX_MATCHES - count);
    if (!matches.length) continue;
    files.push({ path: paths[i], matches });
    count += matches.length;
    if (count >= MAX_MATCHES) { truncated = true; break; }
  }
  // Reads started ahead of a truncated search still land in the cache; they are not waited for.
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
// like `a*` would also insert the replacement at every gap of the file while the preview counted one match. The text
// between matches is copied as it was, separators included; a line break the replacement brings in is the file's
// own (CRLF when most of its line breaks are, as the editor decides).
function replaceText(text, { re, rep, perLine }) {
  const { flat, crlf } = normalized(text);
  const sep = crlf.length * 2 > text.split('\n').length - 1 ? '\r\n' : '\n';
  const raw = (n) => {
    let lo = 0;
    let hi = crlf.length;
    while (lo < hi) { const mid = (lo + hi) >> 1; if (crlf[mid] < n) lo = mid + 1; else hi = mid; }
    return n + lo;
  };
  let out = '';
  let at = 0;
  let count = 0;
  for (const { m, index, str } of matchesOf(flat, re, perLine)) {
    const args = [...m, m.index, str];
    if (m.groups !== undefined) args.push(m.groups);
    out += text.slice(at, raw(index)) + expandReplacement(rep, args).replace(/\n/g, sep);
    at = raw(index + m[0].length);
    count++;
  }
  return { text: count ? out + text.slice(at) : text, count };
}

// A file the preview listed that Replace left as it was: {path, reason: 'tooLarge'|'binary'|'encoding'|'error', ...}.
const skip = (p, reason, e) => ({ path: p, reason, ...(e ? { message: e.message, code: e.code } : {}) });

// UTF-8 files only; the others are returned as `foreign` for the main side to rewrite in their own encoding.
function replaceIn(paths, opts) {
  const c = compile(opts);
  const changed = [];
  const foreign = [];
  const skipped = [];
  let count = 0;
  for (const p of paths) {
    try {
      if (fs.statSync(p).size > MAX_SIZE) { skipped.push(skip(p, 'tooLarge')); continue; }
      const raw = fs.readFileSync(p);
      if (utf16Of(raw)) { foreign.push(p); continue; }
      if (raw.subarray(0, 8000).includes(0)) { skipped.push(skip(p, 'binary')); continue; }
      if (!isUtf8(raw)) { foreign.push(p); continue; }
      // The byte order mark is not text that a pattern such as ^\s+ may remove.
      const text = raw.toString('utf8');
      const bom = text.charCodeAt(0) === 0xfeff ? '﻿' : '';
      const { text: next, count: n } = replaceText(text.slice(bom.length), c);
      if (!n || bom + next === text) continue;
      fs.writeFileSync(p, bom + next, 'utf8');
      changed.push(p);
      count += n;
    } catch (e) {
      skipped.push(skip(p, 'error', e));
    }
  }
  return { changed, count, foreign, skipped };
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

// path -> {mtime, size, items}. The TODO list is rescanned on every save and file change, so a rescan rereads
// only files whose mtime or size moved; unsaved buffers (overrides) always count fresh.
const todoCache = new Map();

function todos(root, overrides, excluded) {
  const unsaved = overrideOf(overrides);
  const files = [];
  let count = 0;
  walk(root, (p) => {
    const ext = path.extname(p).slice(1).toLowerCase();
    const marker = COMMENT[ext] || (HASH_EXT.has(ext) ? '#' : null);
    if (!marker) return;
    const text = unsaved(p);
    let items;
    if (text !== undefined) items = todoItems(text, marker);
    else {
      let st;
      try { st = fs.statSync(p); } catch { return; }
      const hit = todoCache.get(p);
      if (hit && hit.mtime === st.mtimeMs && hit.size === st.size) items = hit.items;
      else {
        items = todoItems(readText(p), marker);
        todoCache.set(p, { mtime: st.mtimeMs, size: st.size, items });
      }
    }
    if (items.length) { files.push({ path: p, items }); count += items.length; }
    if (count >= 5000) return false;
  }, excluded);
  files.sort((a, b) => a.path.localeCompare(b.path));
  return { files, count };
}

// Python files under root with their mtime, for the symbol index.
function pyFiles(root, excluded) {
  const out = [];
  walk(root, (p) => {
    if (!PY_EXT.test(p)) return;
    try { const st = fs.statSync(p); if (st.size <= MAX_SIZE) out.push({ p, mtime: st.mtimeMs }); } catch {}
  }, excluded);
  return out;
}

// The renderer names paths as its tabs and the watcher spell them, which may differ in case from the walk's.
function invalidateScans(paths) {
  if (!paths) {
    todoCache.clear();
    textCache.clear();
    textCacheChars = 0;
    return;
  }
  const gone = new Set(paths.map((p) => String(p).toLowerCase()));
  for (const p of [...todoCache.keys()]) if (gone.has(p.toLowerCase())) todoCache.delete(p);
  for (const p of [...textCache.keys()]) if (gone.has(p.toLowerCase())) forgetText(p);
}

// File scans run on a worker thread: on a large project they read thousands of files, and doing that on the main
// process froze every window and IPC call until it finished.
const SCANS = { find, replace: (paths, opts) => replaceIn(paths, opts), todos, pyFiles, invalidate: invalidateScans };
if (!isMainThread && workerData?.role === 'pyide-search') {
  // One request at a time, answered in order (worker-host times the first one waiting), although find awaits reads.
  let queue = Promise.resolve();
  parentPort.on('message', ({ id, op, args }) => {
    queue = queue.then(() => SCANS[op](...args)).then((result) => parentPort.postMessage({ id, result }),
      (e) => parentPort.postMessage({ id, error: e.message, code: e.code }));
  });
}

// Main side; worker-host evaluates this file as the worker (the role check above).
const scan = isMainThread ? require('../worker-host').fileWorker(__filename, 'pyide-search') : null;
// The symbol index lists the project's files on a worker of its own: behind the TODO scan, which reads every file,
// Go to Class stayed empty for 19 s after a 3,000-module project opened (5.6 s now; verify/perf-index.mjs).
const indexScan = isMainThread ? require('../worker-host').fileWorker(__filename, 'pyide-search') : null;
const textCodec = isMainThread ? require('../text-codec') : null;
const pathCase = isMainThread ? require('../path-case') : null;
// The worker cannot read the user data the Excluded folders are kept in, so main passes them with each scan.
const excludedOf = isMainThread ? require('../project-roots').excludedDirs : null;

// The renderer sends unsaved texts by path. They are keyed as documents are (main/path-case.js's pathKey), with the
// case-sensitive folders above them, so in such a folder a.py and A.py each find their own unsaved text.
// -> {texts: {pathKey: text}, dirs: [dirKey]}
function keyedOverrides(overrides) {
  const texts = {};
  const dirs = new Set();
  for (const [p, text] of Object.entries(overrides || {})) {
    texts[pathCase.pathKey(p)] = text;
    for (let d = path.dirname(p); ; d = path.dirname(d)) {
      // A name inside a case-sensitive folder keeps its case in the key.
      if (pathCase.pathKey(path.join(d, 'A')).endsWith('A')) dirs.add(dirKeyOf(pathCase.pathKey(d)));
      if (path.dirname(d) === d) break;
    }
  }
  return { texts, dirs: [...dirs] };
}

// Replaces in the files the worker left alone (CP949 and other non-UTF-8 text), keeping their encoding. A file whose
// encoding cannot hold the new text (an emoji into CP949) is left as it was and reported.
function replaceForeign(paths, opts) {
  const c = compile(opts);
  const changed = [];
  const skipped = [];
  let count = 0;
  for (const p of paths) {
    try {
      const file = textCodec.read(p);
      if (file.text === undefined) { skipped.push(skip(p, file.binary ? 'binary' : 'tooLarge')); continue; }
      const { text, count: n } = replaceText(file.text, c);
      if (!n || text === file.text) continue;
      if (textCodec.decode(textCodec.encode(text, file.encoding), file.encoding) !== text) {
        skipped.push({ path: p, reason: 'encoding', encoding: file.encoding });
        continue;
      }
      textCodec.write(p, text, file.encoding);
      changed.push(p);
      count += n;
    } catch (e) {
      skipped.push(skip(p, 'error', e));
    }
  }
  return { changed, count, skipped };
}

// A user's regex can backtrack for hours (`(a+)+$` on a long line), and every later scan waits behind it on the
// worker; a search that runs past its limit is stopped (worker-host terminates the worker) and answers {stopped}.
// PYIDE_FIND_TIMEOUT_MS shortens both search limits for the tests.
const FIND_TIMEOUT = Number(process.env.PYIDE_FIND_TIMEOUT_MS) || 60000;
const PREVIEW_TIMEOUT = Number(process.env.PYIDE_FIND_TIMEOUT_MS) || 30000;
const REPLACE_TIMEOUT = 120000;
const SUPERSEDED = () => ({ files: [], count: 0, superseded: true });
const findOnWorker = (args, timeout, signal) => scan.with({ timeout, signal }, 'find', ...args).catch((e) => {
  if (e.code === 'ABORT_ERR') return SUPERSEDED();
  if (e.code === 'ETIMEDOUT') return { files: [], count: 0, stopped: timeout / 1000 };
  return { files: [], count: 0, failed: e.message };
});

// The Find in Files dialog searches as the user types, and every search reads the whole project on the worker, one
// after another. A preview search (`live`) therefore waits only behind the one running: a newer preview replaces it,
// and the replaced one answers {superseded: true} at once instead of scanning the project for text nobody sees.
// A running preview that a newer one replaced is stopped once it has run for a second, so a slow pattern typed on
// the way to the intended one does not hold up the search for that one.
let liveBusy = null; // {ctl, started, stop}: the preview the worker runs
let liveNext = null;
function liveFind(args) {
  return new Promise((resolve) => {
    liveNext?.resolve(SUPERSEDED());
    liveNext = { args, resolve };
    if (liveBusy && !liveBusy.stop) {
      const { ctl, started } = liveBusy;
      liveBusy.stop = setTimeout(() => ctl.abort(), Math.max(0, started + 1000 - Date.now()));
    }
    pumpLive();
  });
}
// A search for the Find tool window closes the dialog, so its previews are dropped and a running one stops now.
function dropPreviews() {
  liveNext?.resolve(SUPERSEDED());
  liveNext = null;
  liveBusy?.ctl.abort();
}
function pumpLive() {
  if (liveBusy || !liveNext) return;
  const { args, resolve } = liveNext;
  liveNext = null;
  const busy = (liveBusy = { ctl: new AbortController(), started: Date.now(), stop: null });
  findOnWorker(args, PREVIEW_TIMEOUT, busy.ctl.signal).then(resolve).finally(() => {
    clearTimeout(busy.stop);
    liveBusy = null;
    pumpLive();
  });
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
if mode == 'tag':
    print(json.dumps('%s-%d.%d' % (sys.implementation.name, sys.version_info[0], sys.version_info[1])))
elif mode == 'outline':
    src = sys.stdin.buffer.read().decode('utf-8', 'replace')
    try:
        tree = ast.parse(src)
        print(json.dumps({'items': outline(tree, src.splitlines())}))
    except SyntaxError as e:
        print(json.dumps({'error': e.msg, 'line': e.lineno or 1}))
else:
    from concurrent.futures import ThreadPoolExecutor

    def source(p):
        try:
            with open(p, 'rb') as f:
                return f.read().decode('utf-8', 'replace')
        except Exception:
            return None

    # A file the virus scanner has not seen (a project just cloned or generated) is held at its first open until it
    # is scanned; reading on threads overlaps those waits while the files read so far are parsed.
    paths = json.loads(sys.stdin.buffer.read().decode('utf-8'))
    result = {}
    with ThreadPoolExecutor(16) as pool:
        for p, src in zip(paths, pool.map(source, paths)):
            try:
                result[p] = flatten(outline(ast.parse(src), src.splitlines()), '', []) if src is not None else []
            except Exception:
                result[p] = []
    print(json.dumps(result))
`;

// Resolves to null when Python fails or does not answer within `timeout` ms (then it is killed with its children:
// interp.cmd can be a launcher such as py.exe).
function runAst(interp, mode, input, timeout) {
  return new Promise((resolve) => {
    let p;
    try { p = spawn(interp.cmd, [...interp.args, '-c', AST_SCRIPT, mode], { windowsHide: true }); } catch { return resolve(null); }
    let out = '';
    const timer = setTimeout(() => {
      resolve(null);
      if (process.platform === 'win32') spawn('taskkill', ['/pid', String(p.pid), '/T', '/F'], { windowsHide: true }).on('error', () => {});
      else p.kill();
    }, timeout);
    p.stdout.on('data', (d) => (out += d));
    p.on('error', () => { clearTimeout(timer); resolve(null); });
    p.on('close', () => { clearTimeout(timer); try { resolve(JSON.parse(out)); } catch { resolve(null); } });
    p.stdin.on('error', () => {});
    p.stdin.end(input, 'utf8');
  });
}

// The symbol index: pathLower -> {path, mtime, py, symbols, v}, refreshed by mtime and by the Python that parsed the
// file: `py` is its tag (implementation-major.minor), because a file in newer syntax parses to nothing under an older
// Python. `v` is the index version that last changed the file's symbols, so a window that already holds version n is
// sent only what changed after n.
const symbolCache = new Map();
const removedAt = new Map(); // pathLower -> the version that dropped the file
let indexVersion = 0;
let fullSince = 0; // a window holding an older version than this is sent the whole index
let indexQueue = Promise.resolve();
const BATCH = 400;
// Python parses the batches side by side: 3,000 modules take 1.2 s instead of 3.2 s one batch after another.
const PARALLEL = Math.max(1, Math.min(4, os.cpus().length - 1));
// interpreter -> its tag, asked once per session. The renderer's version is in the key, so a venv made again with
// another Python at the same path is asked again. A Python that does not answer has no tag (null, asked again at the
// next build), and then the entries are checked by mtime alone.
const pyTags = new Map();
async function pyTag(interp) {
  const key = JSON.stringify([interp.cmd, interp.args, interp.version]);
  if (!pyTags.has(key)) {
    const tag = await runAst(interp, 'tag', '', 15000);
    if (typeof tag !== 'string') return null;
    pyTags.set(key, tag);
  }
  return pyTags.get(key);
}
const rootKeyOf = (root) => root.toLowerCase().replace(/[\\/]*$/, path.sep);

// Each project's index is kept on disk, so a project opened again lists its symbols at once instead of after Python
// has parsed every file (3,000 modules: 1.4 s, or 5-9 s when the files are new to the virus scanner). Entries are
// checked against the files' mtime and Python like the ones in memory; a store written by another version of
// AST_SCRIPT is ignored.
let storeDir = null;
const STORE_KEEP = 20; // projects whose index stays on disk
let storeFormat;
const formatOf = () => (storeFormat ||= crypto.createHash('sha1').update(AST_SCRIPT).digest('hex').slice(0, 12));
const storeFile = (root) => path.join(storeDir, `${crypto.createHash('sha1').update(rootKeyOf(root)).digest('hex').slice(0, 16)}.json`);
const storedRoots = new Set(); // rootKeys whose store was read this session

async function loadStore(root) {
  const rootKey = rootKeyOf(root);
  if (!storeDir || storedRoots.has(rootKey)) return;
  storedRoots.add(rootKey);
  let data;
  try { data = JSON.parse(await fs.promises.readFile(storeFile(root), 'utf8')); } catch { return; }
  if (data?.format !== formatOf() || rootKeyOf(String(data.root)) !== rootKey || !Array.isArray(data.files)) return;
  const v = ++indexVersion;
  for (const [p, mtime, symbols, py] of data.files) {
    const key = String(p).toLowerCase();
    if (!key.startsWith(rootKey) || symbolCache.has(key) || !Array.isArray(symbols)) continue;
    symbolCache.set(key, { path: p, mtime, py, v, symbols: symbols.map(([name, kind, line, col, container]) => ({ name, kind, line, col, container })) });
  }
}

// A failed write only costs a parse the next time the project opens.
let storeQueue = Promise.resolve();
function saveStore(root) {
  if (!storeDir) return;
  const rootKey = rootKeyOf(root);
  const files = [];
  for (const [key, e] of symbolCache) {
    if (key.startsWith(rootKey)) files.push([e.path, e.mtime, e.symbols.map((s) => [s.name, s.kind, s.line, s.col, s.container]), e.py]);
  }
  const text = JSON.stringify({ format: formatOf(), root, files });
  storeQueue = storeQueue.then(async () => {
    const file = storeFile(root);
    // Two PyIDE processes with the same project open write the same store, each through its own temporary file.
    const tmp = `${file}.${process.pid}.tmp`;
    await fs.promises.mkdir(storeDir, { recursive: true });
    await fs.promises.writeFile(tmp, text);
    await fs.promises.rename(tmp, file).catch((e) => fs.promises.rm(tmp, { force: true }).then(() => { throw e; }));
    const stores = (await fs.promises.readdir(storeDir)).filter((n) => n.endsWith('.json'));
    if (stores.length <= STORE_KEEP) return;
    const dated = await Promise.all(stores.map(async (n) => ({ n, t: (await fs.promises.stat(path.join(storeDir, n))).mtimeMs })));
    for (const { n } of dated.sort((a, b) => b.t - a.t).slice(STORE_KEEP)) await fs.promises.rm(path.join(storeDir, n), { force: true });
  }).catch(() => {});
}

function setSymbols(p, mtime, py, symbols) {
  const key = p.toLowerCase();
  const old = symbolCache.get(key);
  // A save that leaves the symbols as they were (an edit inside a function body) is no change to send.
  if (old && JSON.stringify(old.symbols) === JSON.stringify(symbols)) {
    old.mtime = mtime;
    old.py = py;
    return;
  }
  symbolCache.set(key, { path: p, mtime, py, symbols, v: ++indexVersion });
  removedAt.delete(key);
}

// -> {version, full, files: [[path, symbols]], removed: [pathLower]}: the files whose symbols changed after `since`
// (all of them when `full`), and the files dropped since then.
async function buildIndex(interp, root, since = 0) {
  const asking = pyTag(interp);
  await loadStore(root);
  // With the separator, so indexing C:\proj does not drop the cached files of C:\proj2.
  const rootKey = rootKeyOf(root);
  const live = new Set();
  const stale = [];
  const scanned = await indexScan('pyFiles', root, excludedOf(root));
  const py = await asking;
  for (const { p, mtime } of scanned) {
    const key = p.toLowerCase();
    live.add(key);
    const hit = symbolCache.get(key);
    if (!hit || hit.mtime !== mtime || (py && hit.py !== py)) stale.push({ p, mtime });
  }
  let stored = true; // the store still matches: no file parsed (new mtimes) or dropped
  const batches = [];
  for (let i = 0; i < stale.length; i += BATCH) batches.push(stale.slice(i, i + BATCH));
  const parse = async () => {
    for (let batch; (batch = batches.shift());) {
      const res = await runAst(interp, 'index', JSON.stringify(batch.map((b) => b.p)), 120000);
      // Python failed or timed out: that says nothing about these files. They keep what they had and are parsed again
      // next time, instead of being cached as files without symbols until they change.
      if (!res) continue;
      stored = false;
      for (const { p, mtime } of batch) setSymbols(p, mtime, py, res[p] || []);
    }
  };
  await Promise.all(Array.from({ length: Math.min(PARALLEL, batches.length) }, parse));
  for (const key of symbolCache.keys()) {
    if (key.startsWith(rootKey) && !live.has(key)) {
      symbolCache.delete(key);
      removedAt.set(key, ++indexVersion);
      stored = false;
    }
  }
  if (!stored) saveStore(root);
  const full = !since || since < fullSince;
  const files = [];
  for (const [key, e] of symbolCache) if (key.startsWith(rootKey) && (full || e.v > since)) files.push([e.path, e.symbols]);
  const removed = full ? [] : [...removedAt].filter(([key, v]) => v > since && key.startsWith(rootKey)).map(([key]) => key);
  return { version: indexVersion, full, files, removed };
}

const indexed = (interp, root, since) => {
  const run = indexQueue.then(() => buildIndex(interp, root, since));
  indexQueue = run.catch(() => {});
  return run;
};

exports.register = ({ ipcMain, app }) => {
  storeDir = path.join(app.getPath('userData'), 'symbol-index');
  ipcMain.handle('search:find', (_e, root, opts, overrides, { live } = {}) => {
    const args = [root, opts, keyedOverrides(overrides), excludedOf(root)];
    return live ? liveFind(args) : (dropPreviews(), findOnWorker(args, FIND_TIMEOUT));
  });
  // {changed, count, skipped}, or {stopped} when the worker was stopped partway: some of `paths` may then have been
  // replaced.
  ipcMain.handle('search:replace', async (_e, opts, paths) => {
    let res;
    try {
      res = await scan.with({ timeout: REPLACE_TIMEOUT, resend: false }, 'replace', paths, opts);
    } catch (e) {
      if (e.code === 'ETIMEDOUT') return { changed: [], count: 0, stopped: REPLACE_TIMEOUT / 1000 };
      throw e;
    }
    const other = replaceForeign(res.foreign, opts);
    return { changed: [...res.changed, ...other.changed], count: res.count + other.count, skipped: [...res.skipped, ...other.skipped] };
  });
  // The same replacement applied to an unsaved buffer's text -> {text, count}.
  ipcMain.handle('search:replaceText', (_e, opts, text) => replaceText(text, compile(opts)));
  ipcMain.handle('search:todos', (_e, root, overrides) => scan('todos', root, keyedOverrides(overrides), excludedOf(root)));
  ipcMain.handle('search:outline', async (_e, interp, text) => (await runAst(interp, 'outline', text, 30000)) || { error: 'Python interpreter failed' });
  // The index as one list of {name, kind, line, col, container, path}.
  ipcMain.handle('search:symbols', async (_e, interp, root) => (await indexed(interp, root)).files.flatMap(([p, symbols]) => symbols.map((s) => ({ ...s, path: p }))));
  // What changed since the version the window holds (see buildIndex): Go to Class and Search Everywhere keep the
  // index in the window, so a popup does not copy 50,000 symbols from this process again.
  ipcMain.handle('search:symbolIndex', (_e, interp, root, since) => indexed(interp, root, since));
  // Named files are parsed again at the next build, or dropped from the index if they are gone; without names the
  // whole index is built again.
  ipcMain.handle('search:invalidate', (_e, paths) => {
    if (!paths) {
      symbolCache.clear();
      removedAt.clear();
      fullSince = ++indexVersion;
    } else {
      for (const p of paths) { const e = symbolCache.get(String(p).toLowerCase()); if (e) e.mtime = -1; }
    }
    return scan('invalidate', paths || null);
  });
};
