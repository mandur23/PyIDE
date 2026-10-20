// Project dependency declarations (requirements*.txt, pyproject.toml, Pipfile) and the check of each against the
// packages installed in an interpreter: PEP 508 requirements, PEP 440 versions and specifiers, environment markers.
// Pure functions; main/features/packages.js does the I/O.
const fs = require('fs');
const path = require('path');

const normName = (n) => n.toLowerCase().replace(/[-_.]+/g, '-');

// ---------- PEP 440 versions ----------
const VERSION_RE = /^\s*v?(?:(\d+)!)?(\d+(?:\.\d+)*)(?:[-_.]?(a|b|c|rc|alpha|beta|pre|preview)[-_.]?(\d+)?)?(?:-(\d+)|[-_.]?(post|rev|r)[-_.]?(\d+)?)?(?:[-_.]?(dev)[-_.]?(\d+)?)?(?:\+([a-z0-9]+(?:[-_.][a-z0-9]+)*))?\s*$/i;
const PRE = { a: 0, alpha: 0, b: 1, beta: 1, c: 2, rc: 2, pre: 2, preview: 2 };

function parseVersion(s) {
  const m = VERSION_RE.exec(String(s));
  if (!m) return null;
  return {
    epoch: +(m[1] || 0),
    release: m[2].split('.').map(Number),
    pre: m[3] ? [PRE[m[3].toLowerCase()], +(m[4] || 0)] : null,
    post: m[5] != null ? +m[5] : m[6] ? +(m[7] || 0) : null,
    dev: m[8] ? +(m[9] || 0) : null,
    local: m[10] ? m[10].toLowerCase().split(/[-_.]/) : null,
  };
}

const cmpNum = (a, b) => (a < b ? -1 : a > b ? 1 : 0);
function cmpList(a, b, cmp = cmpNum) {
  for (let i = 0; i < Math.max(a.length, b.length); i++) {
    if (i >= a.length) return -1;
    if (i >= b.length) return 1;
    const c = cmp(a[i], b[i]);
    if (c) return c;
  }
  return 0;
}
const trimZeros = (r) => { const out = [...r]; while (out.length > 1 && out[out.length - 1] === 0) out.pop(); return out; };

// The sort key of packaging.version.Version: dev releases sort before pre-releases, which sort before the release.
function compareVersions(a, b, { ignoreLocal = false } = {}) {
  const key = (v) => [
    v.epoch,
    trimZeros(v.release),
    !v.pre && v.post == null && v.dev != null ? [-Infinity] : v.pre ? v.pre : [Infinity],
    v.post == null ? -Infinity : v.post,
    v.dev == null ? Infinity : v.dev,
  ];
  const ka = key(a), kb = key(b);
  for (let i = 0; i < ka.length; i++) {
    const c = Array.isArray(ka[i]) ? cmpList(ka[i], kb[i]) : cmpNum(ka[i], kb[i]);
    if (c) return c;
  }
  if (ignoreLocal) return 0;
  if (!a.local || !b.local) return cmpNum(a.local ? 1 : 0, b.local ? 1 : 0);
  return cmpList(a.local, b.local, (x, y) => {
    const nx = /^\d+$/.test(x), ny = /^\d+$/.test(y);
    if (nx && ny) return cmpNum(+x, +y);
    if (nx !== ny) return nx ? 1 : -1;
    return cmpNum(x, y);
  });
}

const padRelease = (r, n) => [...r, ...Array(Math.max(0, n - r.length)).fill(0)];

// One clause such as '>=1.2' against an installed version string. Pre-releases count, as in `pip check`.
function clauseMatches(op, target, installed) {
  if (op === '===') return installed.trim().toLowerCase() === target.trim().toLowerCase();
  const v = parseVersion(installed);
  if (!v) return true; // not a PEP 440 version: nothing to say about it
  if ((op === '==' || op === '!=') && /\.\*\s*$/.test(target)) {
    const t = parseVersion(target.replace(/\.\*\s*$/, ''));
    if (!t) return true;
    const n = t.release.length;
    const prefix = v.epoch === t.epoch && cmpList(padRelease(v.release, n).slice(0, n), t.release) === 0;
    return op === '==' ? prefix : !prefix;
  }
  const t = parseVersion(target);
  if (!t) return true;
  const c = compareVersions(v, t, { ignoreLocal: !t.local });
  switch (op) {
    case '==': return c === 0;
    case '!=': return c !== 0;
    case '>=': return c >= 0;
    case '<=': return c <= 0;
    // Exclusive comparisons leave out the post-releases (>) and pre-releases (<) of the version they name.
    case '>': return c > 0 && !(t.post == null && v.post != null && cmpList(trimZeros(v.release), trimZeros(t.release)) === 0);
    case '<': return c < 0 && !(!t.pre && t.dev == null && (v.pre || v.dev != null) && cmpList(trimZeros(v.release), trimZeros(t.release)) === 0);
    case '~=': {
      if (c < 0 || t.release.length < 2) return c >= 0;
      const n = t.release.length - 1;
      return v.epoch === t.epoch && cmpList(padRelease(v.release, n).slice(0, n), t.release.slice(0, n)) === 0;
    }
    default: return true;
  }
}

// '>=1.0,<2' -> [{op, version}]; clauses that do not parse are dropped.
function parseSpecifier(spec) {
  return String(spec || '').split(',').map((s) => /^\s*(~=|===|==|!=|<=|>=|<|>)\s*([^\s,]+)\s*$/.exec(s))
    .filter(Boolean).map((m) => ({ op: m[1], version: m[2] }));
}
const specifierMatches = (spec, installed) => parseSpecifier(spec).every((c) => clauseMatches(c.op, c.version, installed));

// ---------- PEP 508 markers ----------
// env: the marker variables of the interpreter (see PROBE in packages.js). Anything unparseable evaluates to true,
// so a marker this parser does not understand never hides a requirement.
function evaluateMarker(marker, env) {
  if (!marker || !marker.trim()) return true;
  const tokens = [];
  const re = /\s*(?:(\(|\))|('[^']*'|"[^"]*")|(===|==|!=|<=|>=|~=|<|>)|(not\s+in\b|in\b|and\b|or\b)|([A-Za-z_][A-Za-z0-9_.]*))/y;
  let m;
  let pos = 0;
  while (pos < marker.length) {
    re.lastIndex = pos;
    if (!(m = re.exec(marker))) { if (!marker.slice(pos).trim()) break; return true; }
    pos = re.lastIndex;
    if (m[1]) tokens.push({ t: m[1] });
    else if (m[2]) tokens.push({ t: 'str', v: m[2].slice(1, -1) });
    else if (m[3]) tokens.push({ t: 'op', v: m[3] });
    else if (m[4]) { const w = m[4].replace(/\s+/, ' '); tokens.push(w === 'and' || w === 'or' ? { t: w } : { t: 'op', v: w }); }
    else tokens.push({ t: 'var', v: m[5] });
  }
  let i = 0;
  const value = () => {
    const tok = tokens[i++];
    if (tok?.t === 'str') return { str: tok.v };
    if (tok?.t === 'var') return { str: env[tok.v] ?? '', variable: tok.v };
    throw new Error('marker');
  };
  const compare = () => {
    if (tokens[i]?.t === '(') { i++; const r = or(); if (tokens[i++]?.t !== ')') throw new Error('marker'); return r; }
    const left = value();
    const op = tokens[i++];
    if (op?.t !== 'op') throw new Error('marker');
    const right = value();
    if (op.v === 'in') return right.str.includes(left.str);
    if (op.v === 'not in') return !right.str.includes(left.str);
    // Version comparison when both sides are versions (python_version >= "3.8"), string comparison otherwise.
    if (parseVersion(left.str) && parseVersion(right.str) && op.v !== '===') return clauseMatches(op.v, right.str, left.str);
    if (op.v === '==' || op.v === '===') return left.str === right.str;
    if (op.v === '!=') return left.str !== right.str;
    return true;
  };
  const and = () => { let r = compare(); while (tokens[i]?.t === 'and') { i++; r = compare() && r; } return r; };
  const or = () => { let r = and(); while (tokens[i]?.t === 'or') { i++; r = and() || r; } return r; };
  try {
    const r = or();
    return i === tokens.length ? r : true;
  } catch { return true; }
}

// ---------- requirement strings ----------
// 'Foo[bar] >=1.0, <2 ; python_version < "3.11"' -> {name, extras, spec, marker, url}
function parseRequirement(s) {
  const m = /^\s*([A-Za-z0-9](?:[A-Za-z0-9._-]*[A-Za-z0-9])?)\s*(\[[^\]]*\])?\s*(.*)$/s.exec(s);
  if (!m) return null;
  let rest = m[3];
  let marker = '';
  let url = null;
  if (rest.trimStart().startsWith('@')) {
    // A URL may contain ';', so the marker of a URL requirement starts at '; ' after whitespace.
    const at = rest.search(/\s;\s*|\s;$/);
    url = (at >= 0 ? rest.slice(0, at) : rest).trim().slice(1).trim();
    if (at >= 0) marker = rest.slice(at).replace(/^\s*;/, '').trim();
  } else {
    const semi = rest.indexOf(';');
    if (semi >= 0) { marker = rest.slice(semi + 1).trim(); rest = rest.slice(0, semi); }
    rest = rest.trim();
    if (rest && !/^[(~=!<>]/.test(rest)) return null;
  }
  const spec = url ? '' : rest.trim().replace(/^\((.*)\)$/, '$1').trim();
  return { name: m[1], extras: m[2] ? m[2].slice(1, -1).split(',').map((x) => x.trim()).filter(Boolean) : [], spec, marker, url };
}

// ---------- Poetry version constraints ----------
// '^1.2' -> '>=1.2,<2.0'; alternatives joined with '||' -> several PEP 440 specifiers (any may match).
function poetrySpecifiers(constraint) {
  const one = (c) => {
    const out = [];
    for (const part of c.split(/\s*,\s*|\s+(?=[<>=!~^])/).map((x) => x.trim()).filter(Boolean)) {
      if (part === '*' || part === '') continue;
      const caret = /^\^\s*(.+)$/.exec(part);
      const tilde = /^~(?!=)\s*(.+)$/.exec(part);
      if (caret || tilde) {
        const base = (caret || tilde)[1];
        const r = (parseVersion(base)?.release) || [0];
        let upper;
        if (caret) {
          const i = r.findIndex((x) => x !== 0);
          const at = i < 0 ? Math.max(0, r.length - 1) : i;
          upper = [...r.slice(0, at), r[at] + 1];
        } else upper = r.length === 1 ? [r[0] + 1] : [r[0], r[1] + 1];
        out.push(`>=${base}`, `<${upper.join('.')}`);
      } else if (/^[\d]/.test(part)) out.push(`==${part}`);
      else out.push(part.replace(/^=(?!=)/, '=='));
    }
    return out.join(',');
  };
  return String(constraint || '*').split('||').map(one);
}

// ---------- files ----------
// requirements.txt: one requirement per line; options (-r, -e, --index-url...), paths and URLs are not packages.
function parseRequirementsTxt(text) {
  const lines = text.split(/\r?\n/);
  const reqs = [];
  for (let i = 0; i < lines.length; i++) {
    const first = i;
    let line = lines[i];
    while (/\\\s*$/.test(line) && i + 1 < lines.length) line = line.replace(/\\\s*$/, ' ') + lines[++i];
    const body = line.replace(/(^|\s)#.*$/, '').replace(/\s--?[a-z][\w-]*(=\S*|\s+\S+)?/gi, (m) => (/^\s--(hash|config-settings|global-option)/i.test(m) ? '' : m));
    const trimmed = body.trim();
    if (!trimmed || trimmed.startsWith('-') || /^[.\\/]|^\w+(\+\w+)?:\/\//.test(trimmed)) continue;
    const req = parseRequirement(trimmed);
    if (!req) continue;
    const col = lines[first].search(/\S/) + 1;
    const raw = trimmed;
    reqs.push({ ...req, raw, line: first + 1, col, endCol: Math.min(lines[first].length + 1, col + raw.length) });
  }
  return { reqs };
}

// Strips a TOML comment that is not inside a string.
function stripComment(line) {
  let q = null;
  for (let i = 0; i < line.length; i++) {
    const c = line[i];
    if (q) { if (c === '\\' && q === '"') i++; else if (c === q) q = null; } else if (c === '"' || c === "'") q = c; else if (c === '#') return line.slice(0, i);
  }
  return line;
}

// A small line-oriented TOML reader: just enough for the dependency tables, with the position of every value.
// Returns {tables: Set, arrays: [{table, key, items: [{value, line, col, endCol}], open: {line, col}, close: {line, col}}],
//          entries: [{table, key, value, inline: {k: v}, line, col, endCol}]}
function scanToml(text) {
  const lines = text.split(/\r?\n/);
  const tables = new Set();
  const arrays = [];
  const entries = [];
  let table = '';
  const strings = (s, lineNo, offset) => {
    const out = [];
    const re = /"((?:[^"\\]|\\.)*)"|'([^']*)'/g;
    let m;
    while ((m = re.exec(s))) out.push({ value: m[1] != null ? m[1].replace(/\\(.)/g, '$1') : m[2], line: lineNo, col: offset + m.index + 1, endCol: offset + m.index + m[0].length + 1 });
    return out;
  };
  for (let i = 0; i < lines.length; i++) {
    const line = stripComment(lines[i]);
    const header = /^\s*\[\s*([^\][]+?)\s*\]\s*$/.exec(line);
    if (header) { table = header[1].replace(/\s*\.\s*/g, '.').replace(/["']/g, ''); tables.add(table); continue; }
    const kv = /^\s*("[^"]*"|'[^']*'|[A-Za-z0-9_.-]+)\s*=\s*(.*)$/.exec(line);
    if (!kv) continue;
    const key = kv[1].replace(/^["']|["']$/g, '');
    const valueAt = line.length - kv[2].length;
    const v = kv[2];
    if (v.startsWith('[')) {
      const arr = { table, key, items: [], open: { line: i + 1, col: valueAt + 1 }, close: null };
      let depth = 0;
      for (let j = i; j < lines.length; j++) {
        const s = j === i ? v : stripComment(lines[j]);
        const offset = j === i ? valueAt : 0;
        // Brackets inside strings do not count.
        const bare = s.replace(/"(?:[^"\\]|\\.)*"|'[^']*'/g, (x) => ' '.repeat(x.length));
        arr.items.push(...strings(s, j + 1, offset));
        for (let k = 0; k < bare.length; k++) {
          if (bare[k] === '[') depth++;
          else if (bare[k] === ']' && --depth === 0) { arr.close = { line: j + 1, col: offset + k + 1 }; break; }
        }
        if (arr.close) { i = j; break; }
      }
      arrays.push(arr);
      continue;
    }
    const entry = { table, key, value: null, inline: null, line: i + 1, col: lines[i].search(/\S/) + 1, endCol: line.trimEnd().length + 1 };
    const str = strings(v, i + 1, valueAt)[0];
    if (v.startsWith('{')) {
      entry.inline = {};
      for (const m of v.matchAll(/([A-Za-z0-9_-]+)\s*=\s*("(?:[^"\\]|\\.)*"|'[^']*'|true|false|[\d.]+)/g)) entry.inline[m[1]] = m[2].replace(/^["']|["']$/g, '');
    } else if (str) entry.value = str.value;
    entries.push(entry);
  }
  return { tables, arrays, entries };
}

// A table of `name = "constraint"` or `name = {version = "...", markers = "...", optional = true}` (Poetry, Pipfile).
function tableRequirements(toml, table, { poetry }) {
  const reqs = [];
  for (const e of toml.entries) {
    if (e.table !== table || (poetry && e.key.toLowerCase() === 'python')) continue;
    const opts = e.inline || {};
    if (opts.optional === 'true') continue;
    const constraint = e.inline ? opts.version : e.value;
    const alternatives = poetry ? poetrySpecifiers(constraint) : [constraint && constraint !== '*' ? constraint : ''];
    const marker = [opts.markers, opts.python && poetry ? poetrySpecifiers(opts.python).map((s) => parseSpecifier(s).map((c) => `python_version ${c.op} "${c.version}"`).join(' and ')).filter(Boolean).map((x) => `(${x})`).join(' or ') : '']
      .filter(Boolean).map((x) => `(${x})`).join(' and ');
    const local = !!(opts.path || opts.git || opts.url || opts.file);
    reqs.push({
      name: e.key, extras: [], spec: local ? '' : alternatives[0], alternatives: local ? [''] : alternatives, marker, url: local ? (opts.path || opts.git || opts.url || opts.file) : null,
      raw: `${e.key}${local ? '' : alternatives[0]}${marker ? ` ; ${marker}` : ''}`, line: e.line, col: e.col, endCol: e.endCol,
    });
  }
  return reqs;
}

function parsePyproject(text) {
  const toml = scanToml(text);
  const reqs = [];
  const deps = toml.arrays.find((a) => a.table === 'project' && a.key === 'dependencies');
  for (const item of deps?.items || []) {
    const req = parseRequirement(item.value);
    if (req) reqs.push({ ...req, raw: item.value.trim(), line: item.line, col: item.col + 1, endCol: item.endCol - 1 });
  }
  reqs.push(...tableRequirements(toml, 'tool.poetry.dependencies', { poetry: true }));
  const has = (prefix) => [...toml.tables].some((t) => t === prefix || t.startsWith(`${prefix}.`));
  return { reqs, poetry: has('tool.poetry'), uv: has('tool.uv'), projectDeps: deps || null, hasProject: toml.tables.has('project') };
}

const parsePipfile = (text) => ({ reqs: tableRequirements(scanToml(text), 'packages', { poetry: false }) });

const KIND_OF = (name) => {
  const n = name.toLowerCase();
  if (/^requirements.*\.txt$/.test(n)) return 'requirements';
  if (n === 'pyproject.toml') return 'pyproject';
  if (n === 'pipfile') return 'pipfile';
  return null;
};
const parseFile = (kind, text) => (kind === 'requirements' ? parseRequirementsTxt(text) : kind === 'pyproject' ? parsePyproject(text) : parsePipfile(text));

const decodeText = (buf) => (buf[0] === 0xff && buf[1] === 0xfe ? buf.toString('utf16le', 2)
  : buf[0] === 0xfe && buf[1] === 0xff ? Buffer.from(buf.subarray(2)).swap16().toString('utf16le')
    : buf.toString('utf8').replace(/^﻿/, ''));

// Dependency files in the project root and the manager they imply: a lock file picks uv or Poetry, so does a
// [tool.poetry] / [tool.uv] table; otherwise pip. texts: {path: unsaved editor text} overrides what is on disk.
function detect(root, texts = {}) {
  let names = [];
  try { names = fs.readdirSync(root); } catch { return { manager: 'pip', files: [] }; }
  const textOf = (p) => {
    const hit = Object.keys(texts).find((k) => k.toLowerCase() === p.toLowerCase());
    if (hit) return texts[hit];
    // Windows PowerShell's `pip freeze > requirements.txt` writes UTF-16 with a BOM, which pip reads too.
    try { return decodeText(fs.readFileSync(p)); } catch { return null; }
  };
  const files = [];
  for (const name of names.sort()) {
    const kind = KIND_OF(name);
    if (!kind) continue;
    const p = path.join(root, name);
    const text = textOf(p);
    if (text == null) continue;
    const parsed = parseFile(kind, text);
    // A pyproject.toml without dependencies (a tool config only) is not a dependency file.
    if (kind === 'pyproject' && !parsed.reqs.length && !parsed.poetry && !parsed.projectDeps) continue;
    files.push({ path: p, kind, ...parsed });
  }
  // requirements.txt first: it is what "Add to requirements" and the Packages window name.
  files.sort((a, b) => (a.kind === b.kind ? 0 : a.kind === 'requirements' ? -1 : b.kind === 'requirements' ? 1 : 0)
    || (path.basename(a.path).toLowerCase() === 'requirements.txt' ? -1 : 0) || a.path.localeCompare(b.path));
  const lower = names.map((n) => n.toLowerCase());
  const pyproject = files.find((f) => f.kind === 'pyproject');
  const manager = lower.includes('uv.lock') ? 'uv' : lower.includes('poetry.lock') ? 'poetry'
    : pyproject?.poetry ? 'poetry' : pyproject?.uv ? 'uv' : 'pip';
  return { manager, lock: lower.includes('uv.lock') ? 'uv.lock' : lower.includes('poetry.lock') ? 'poetry.lock' : null, files };
}

// installed: Map normName -> {name, version}; env: marker variables. Marks each requirement ok / missing / outdated.
function check(files, installed, env) {
  return files.map((f) => ({
    path: f.path,
    kind: f.kind,
    reqs: f.reqs.filter((r) => evaluateMarker(r.marker, env)).map((r) => {
      const hit = installed.get(normName(r.name));
      const alternatives = r.alternatives || [r.spec];
      const status = !hit ? 'missing' : alternatives.some((s) => specifierMatches(s, hit.version)) ? 'ok' : 'outdated';
      return { name: r.name, spec: alternatives.join(' || '), raw: r.raw, url: r.url, line: r.line, col: r.col, endCol: r.endCol, status, installed: hit?.version || null };
    }),
  }));
}

// The text of a dependency file with `requirement` added: a new line in requirements.txt, a new item in
// [project].dependencies of pyproject.toml (the array is created when missing).
function addRequirement(kind, text, requirement) {
  const eol = text.includes('\r\n') ? '\r\n' : '\n';
  if (kind === 'requirements') return `${text}${text && !/\r?\n$/.test(text) ? eol : ''}${requirement}${eol}`;
  if (kind !== 'pyproject') throw new Error(`cannot add requirements to ${kind}`);
  const lines = text.split(/\r?\n/);
  const { projectDeps: deps, hasProject } = parsePyproject(text);
  const item = JSON.stringify(requirement);
  if (deps?.close) {
    const close = lines[deps.close.line - 1];
    if (deps.close.line === deps.open.line) {
      const inside = close.slice(deps.open.col, deps.close.col - 1).trim().replace(/,\s*$/, '');
      lines[deps.close.line - 1] = `${close.slice(0, deps.open.col)}${inside ? `${inside}, ` : ''}${item}${close.slice(deps.close.col - 1)}`;
    } else {
      const indent = deps.items.length ? lines[deps.items[deps.items.length - 1].line - 1].match(/^\s*/)[0] : '    ';
      let last = deps.close.line - 2;
      while (last >= deps.open.line - 1 && !stripComment(lines[last]).trim()) last--;
      const prev = stripComment(lines[last]).trimEnd();
      if (deps.items.length && !prev.endsWith(',') && !prev.endsWith('[')) lines[last] = lines[last].replace(prev, `${prev},`);
      lines.splice(deps.close.line - 1, 0, `${indent}${item},`);
    }
    return lines.join(eol);
  }
  if (hasProject) {
    const at = lines.findIndex((l) => /^\s*\[\s*project\s*\]\s*$/.test(stripComment(l)));
    lines.splice(at + 1, 0, `dependencies = [${eol}    ${item},${eol}]`);
    return lines.join(eol);
  }
  return `${text}${text && !/\r?\n$/.test(text) ? eol : ''}${eol}[project]${eol}dependencies = [${eol}    ${item},${eol}]${eol}`;
}

module.exports = {
  normName, parseVersion, compareVersions, specifierMatches, evaluateMarker, parseRequirement, poetrySpecifiers,
  parseRequirementsTxt, parsePyproject, parsePipfile, detect, check, addRequirement,
};
