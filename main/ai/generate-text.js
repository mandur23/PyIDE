// Python source analysis and text assembly for the AI actions Write Documentation and Generate Unit Tests
// (main/features/ai-generate.js). Pure functions without IO, so verify/ai-generate.mjs checks them in plain Node.

// ---------- tokens ----------
// A small Python tokenizer: strings (any prefix, triple quotes, escapes), comments, names, single-character operators,
// bracket depth, and line ends that end a logical line (not inside brackets, not after a backslash continuation).
const STRING_PREFIX = /^(?:[rRbBuUfF]|[rR][bBfF]|[bBfF][rR])$/;
const isNameStart = (c) => /[A-Za-z_]/.test(c) || c > '\u007f';
const isNameChar = (c) => /\w/.test(c) || c > '\u007f';

function tokenize(text) {
  const toks = [];
  const n = text.length;
  let i = 0;
  let line = 1;
  let lineStart = 0;
  let depth = 0;
  const newline = () => {
    const len = text[i] === '\r' && text[i + 1] === '\n' ? 2 : 1;
    i += len;
    line++;
    lineStart = i;
  };
  const readString = (start, prefix) => {
    const startLine = line;
    const col = start - lineStart;
    const q = text[i];
    const triple = text.startsWith(q.repeat(3), i);
    i += triple ? 3 : 1;
    for (;;) {
      if (i >= n) break;
      const c = text[i];
      if (c === '\\') {
        i++;
        if (text[i] === '\r' || text[i] === '\n') newline(); else i++;
        continue;
      }
      if (triple) {
        if (text.startsWith(q.repeat(3), i)) { i += 3; break; }
      } else if (c === q) { i++; break; }
      if (c === '\r' || c === '\n') {
        if (!triple) break; // unterminated
        newline();
        continue;
      }
      i++;
    }
    toks.push({ type: 'string', start, end: i, line: startLine, endLine: line, col, depth, prefix, quote: triple ? q.repeat(3) : q });
  };
  while (i < n) {
    const c = text[i];
    if (c === '\r' || c === '\n') {
      if (depth === 0) toks.push({ type: 'nl', start: i, end: i, line, endLine: line, col: i - lineStart, depth });
      newline();
      continue;
    }
    if (c === ' ' || c === '\t' || c === '\f') { i++; continue; }
    if (c === '#') {
      const start = i;
      while (i < n && text[i] !== '\n' && text[i] !== '\r') i++;
      toks.push({ type: 'comment', start, end: i, line, endLine: line, col: start - lineStart, depth });
      continue;
    }
    if (c === '\\' && (text[i + 1] === '\n' || text[i + 1] === '\r')) { i++; newline(); continue; }
    if (c === '"' || c === "'") { readString(i, ''); continue; }
    if (isNameStart(c)) {
      const start = i;
      while (i < n && isNameChar(text[i])) i++;
      const word = text.slice(start, i);
      if ((text[i] === '"' || text[i] === "'") && STRING_PREFIX.test(word)) { readString(start, word); continue; }
      toks.push({ type: 'name', text: word, start, end: i, line, endLine: line, col: start - lineStart, depth });
      continue;
    }
    if (/\d/.test(c)) {
      const start = i;
      while (i < n && /[\w.]/.test(text[i])) i++;
      toks.push({ type: 'number', start, end: i, line, endLine: line, col: start - lineStart, depth });
      continue;
    }
    const tok = { type: 'op', text: c, start: i, end: i + 1, line, endLine: line, col: i - lineStart, depth };
    if ('([{'.includes(c)) depth++;
    else if (')]}'.includes(c)) { depth = Math.max(0, depth - 1); tok.depth = depth; }
    toks.push(tok);
    i++;
  }
  return toks;
}

// Logical lines: [{line, endLine, indent (width), tokens (no comments)}]; comment-only and blank lines are left out.
function logicalLines(text, toks = tokenize(text)) {
  const lines = text.split(/\r\n|\r|\n/);
  const out = [];
  let cur = [];
  const flush = () => {
    if (cur.length) {
      const first = cur[0];
      const ws = lines[first.line - 1].match(/^[ \t]*/)[0];
      out.push({ line: first.line, endLine: cur[cur.length - 1].endLine, indent: width(ws), ws, tokens: cur });
    }
    cur = [];
  };
  for (const t of toks) {
    if (t.type === 'nl') flush();
    else if (t.type !== 'comment') cur.push(t);
  }
  flush();
  return out;
}

const width = (ws) => [...ws].reduce((w, ch) => (ch === '\t' ? w + 8 - (w % 8) : w + 1), 0);

// ---------- outline ----------
// Every def and class: {kind: 'def'|'class', isAsync, name, line, decoStart, headerEnd, end, indent, ws, oneLiner,
// body: logical lines, docstring: {start, end, quote, prefix} | null, parent, children}.
function outline(text) {
  const toks = tokenize(text);
  const lls = logicalLines(text, toks);
  const nodes = [];
  const stack = [];
  for (let k = 0; k < lls.length; k++) {
    const ll = lls[k];
    while (stack.length && ll.indent <= stack[stack.length - 1].indentWidth) stack.pop();
    const t = ll.tokens;
    let at = 0;
    let isAsync = false;
    if (t[0]?.type === 'name' && t[0].text === 'async' && t[1]?.text === 'def') { isAsync = true; at = 1; }
    const kw = t[at];
    if (kw?.type !== 'name' || (kw.text !== 'def' && kw.text !== 'class') || t[at + 1]?.type !== 'name') continue;
    // The header ends at the first ':' outside brackets.
    const colonIdx = t.findIndex((x, j) => j > at + 1 && x.type === 'op' && x.text === ':' && x.depth === 0);
    if (colonIdx < 0) continue;
    const colon = t[colonIdx];
    let decoStart = ll.line;
    for (let d = k - 1; d >= 0 && lls[d].indent === ll.indent && lls[d].tokens[0]?.text === '@'; d--) decoStart = lls[d].line;
    const body = [];
    let j = k + 1;
    while (j < lls.length && lls[j].indent > ll.indent) body.push(lls[j++]);
    const oneLiner = colonIdx < t.length - 1;
    const end = body.length ? body[body.length - 1].endLine : ll.endLine;
    let docstring = null;
    const first = body[0];
    if (!oneLiner && first && first.tokens.every((x) => x.type === 'string')) {
      const s = first.tokens[0];
      docstring = { start: first.line, end: first.endLine, quote: s.quote, prefix: s.prefix };
    }
    const node = {
      kind: kw.text, isAsync, name: t[at + 1].text, line: ll.line, decoStart, headerEnd: colon.line, end,
      indentWidth: ll.indent, ws: ll.ws, oneLiner, body, docstring, headerStart: t[0].start, colonOffset: colon.start,
      tokens: t, parent: stack.length ? stack[stack.length - 1] : null, children: [],
    };
    node.parent?.children.push(node);
    nodes.push(node);
    stack.push(node);
  }
  return { nodes, lls, toks };
}

const qualname = (n) => (n.parent ? `${qualname(n.parent)}.${n.name}` : n.name);
const kindOf = (n) => (n.kind === 'class' ? 'class' : n.parent?.kind === 'class' ? 'method' : 'function');

// The innermost def/class whose lines (decorators to the end of the body) hold `line`.
function findTarget(text, line, o = outline(text)) {
  let best = null;
  for (const n of o.nodes) if (line >= n.decoStart && line <= n.end && (!best || n.decoStart >= best.decoStart)) best = n;
  return best;
}

// The def/class whose header (decorators to the colon) holds `line`: Alt+Enter offers the actions only there.
function headerAt(text, line, o = outline(text)) {
  return o.nodes.find((n) => line >= n.decoStart && line <= n.headerEnd) || null;
}

// The node named `name` closest to `line` (after edits elsewhere in the file moved it).
function relocate(text, line, name, o = outline(text)) {
  let best = null;
  for (const n of o.nodes) if (n.name === name && (!best || Math.abs(n.line - line) < Math.abs(best.line - line))) best = n;
  return best;
}

// ---------- signatures ----------
// Index of the first `ch` (one of chars) outside brackets and strings, or -1.
function topIndex(s, chars, from = 0) {
  let depth = 0;
  for (let i = from; i < s.length; i++) {
    const c = s[i];
    if (c === '"' || c === "'") {
      const triple = s.startsWith(c.repeat(3), i);
      const q = triple ? c.repeat(3) : c;
      i += q.length;
      while (i < s.length && !s.startsWith(q, i)) i += s[i] === '\\' ? 2 : 1;
      i += q.length - 1;
      continue;
    }
    if (depth === 0 && chars.includes(c)) return i;
    if ('([{'.includes(c)) depth++;
    else if (')]}'.includes(c)) depth--;
  }
  return -1;
}

function splitTop(s, ch) {
  const out = [];
  let from = 0;
  for (;;) {
    const i = topIndex(s, ch, from);
    if (i < 0) { out.push(s.slice(from)); return out; }
    out.push(s.slice(from, i));
    from = i + 1;
  }
}

const squash = (s) => s.replace(/\s+/g, ' ').trim();

// Header source without comments, from `def`/`class` to the colon.
function headerText(text, node) {
  return node.tokens.filter((x) => x.start < node.colonOffset).map((x) => text.slice(x.start, x.end))
    .reduce((acc, piece, i, all) => {
      const prev = node.tokens[i - 1];
      return acc + (i && prev && node.tokens[i].start > prev.end ? ' ' : '') + piece;
    }, '');
}

function parseParams(inside) {
  const params = [];
  let kind = 'normal';
  for (const raw of splitTop(inside, ',')) {
    const p = squash(raw);
    if (!p) continue;
    if (p === '/') { for (const x of params) x.kind = 'positional'; continue; }
    if (p === '*') { kind = 'keyword'; continue; }
    const eq = topIndex(p, '=');
    const decl = eq >= 0 ? p.slice(0, eq).trim() : p;
    const colon = topIndex(decl, ':');
    let name = (colon >= 0 ? decl.slice(0, colon) : decl).trim();
    const star = name.match(/^\*{1,2}/)?.[0] || '';
    name = name.slice(star.length);
    params.push({
      name,
      annotation: colon >= 0 ? decl.slice(colon + 1).trim() : null,
      default: eq >= 0 ? p.slice(eq + 1).trim() : null,
      kind: star === '*' ? 'varargs' : star === '**' ? 'varkw' : kind,
    });
    if (star === '*') kind = 'keyword';
  }
  return params;
}

// Names of exceptions raised in the node's own body (not in nested defs and classes).
function raisesOf(node) {
  const nested = node.children.map((c) => [c.decoStart, c.end]);
  const out = [];
  for (const ll of node.body) {
    if (nested.some(([a, b]) => ll.line >= a && ll.line <= b)) continue;
    const t = ll.tokens;
    for (let i = 0; i < t.length - 1; i++) {
      if (t[i].type !== 'name' || t[i].text !== 'raise' || t[i + 1].type !== 'name') continue;
      let name = t[i + 1].text;
      for (let j = i + 2; t[j]?.text === '.' && t[j + 1]?.type === 'name'; j += 2) name += `.${t[j + 1].text}`;
      if (!out.includes(name)) out.push(name);
    }
  }
  return out;
}

const ownTokens = (node) => {
  const nested = node.children.map((c) => [c.decoStart, c.end]);
  return node.body.filter((ll) => !nested.some(([a, b]) => ll.line >= a && ll.line <= b)).flatMap((ll) => ll.tokens);
};

// {name, kind, qualname, isAsync, params, returns, raises, isGenerator, decorators, bases?, attributes?}
function signature(text, node) {
  const head = headerText(text, node);
  const lines = text.split(/\r\n|\r|\n/);
  const decorators = lines.slice(node.decoStart - 1, node.line - 1).map((l) => l.trim()).filter((l) => l.startsWith('@'));
  const sig = { name: node.name, kind: kindOf(node), qualname: qualname(node), isAsync: node.isAsync, decorators };
  const open = head.indexOf('(');
  const close = open >= 0 ? open + topIndex(head.slice(open + 1), ')') + 1 : -1;
  const inside = open >= 0 && close > open ? head.slice(open + 1, close) : '';
  if (node.kind === 'class') {
    sig.bases = inside ? splitTop(inside, ',').map(squash).filter(Boolean) : [];
    const init = node.children.find((c) => c.kind === 'def' && c.name === '__init__');
    const initSig = init ? signature(text, init) : null;
    sig.params = initSig ? initSig.params : [];
    sig.raises = initSig ? initSig.raises : [];
    const attrs = [];
    if (init) {
      for (const ll of init.body) {
        const t = ll.tokens;
        if (t[0]?.text === 'self' && t[1]?.text === '.' && t[2]?.type === 'name' && t.some((x) => x.text === '=' && x.depth === 0) && !attrs.includes(t[2].text)) attrs.push(t[2].text);
      }
    }
    sig.attributes = attrs;
    return sig;
  }
  let params = parseParams(inside);
  const isStatic = decorators.some((d) => /^@staticmethod\b/.test(d));
  if (sig.kind === 'method' && !isStatic && params.length && params[0].kind !== 'varargs') params = params.slice(1);
  sig.params = params;
  const after = close >= 0 ? head.slice(close + 1) : '';
  const arrow = after.indexOf('->');
  sig.returns = arrow >= 0 ? squash(after.slice(arrow + 2)) : null;
  sig.raises = raisesOf(node);
  sig.isGenerator = ownTokens(node).some((x) => x.type === 'name' && x.text === 'yield');
  return sig;
}

// ---------- context ----------
const LIMITS = { code: 12000, imports: 2000, classHeader: 1500, helpers: 4000, helperLines: 40 };

// Cuts at a line boundary and says how many lines were left out.
function cutLines(s, max) {
  if (s.length <= max) return { text: s, cut: false };
  const head = s.slice(0, max);
  const kept = head.slice(0, Math.max(0, head.lastIndexOf('\n')));
  const dropped = s.slice(kept.length).split('\n').length - 1;
  return { text: `${kept}\n# … (${dropped} more lines not shown)`, cut: true };
}

const linesOf = (text, from, to) => text.split(/\r\n|\r|\n/).slice(from - 1, to).join('\n');

// Only what the model needs: the target's own source, the module's imports, its class header (methods), and small
// helpers from the same file that it calls. purpose 'tests' adds the class's __init__ for a method.
function buildContext(text, node, { purpose = 'docstring', limits = LIMITS } = {}) {
  const o = outline(text);
  const imports = o.lls.filter((ll) => ll.indent === 0 && ['import', 'from'].includes(ll.tokens[0]?.text))
    .map((ll) => linesOf(text, ll.line, ll.endLine)).join('\n');
  const code = cutLines(linesOf(text, node.decoStart, node.end), limits.code);
  let classHeader = '';
  const cls = node.parent?.kind === 'class' ? node.parent : null;
  if (cls) classHeader = cutLines(linesOf(text, cls.decoStart, cls.headerEnd), limits.classHeader).text;
  // Helpers: module-level functions and classes the code calls, sibling methods it calls through self/cls, and for
  // tests of a method its class's __init__ (how to build the object).
  const called = new Set();
  const src = code.text;
  for (const m of src.matchAll(/(?<![.\w])([A-Za-z_]\w*)\s*\(/g)) called.add(m[1]);
  const viaSelf = new Set([...src.matchAll(/\b(?:self|cls)\.([A-Za-z_]\w*)\s*\(/g)].map((m) => m[1]));
  const top = o.nodes.filter((n) => !n.parent);
  const candidates = [];
  if (cls && purpose === 'tests') {
    const init = cls.children.find((c) => c.name === '__init__' && c !== node);
    if (init) candidates.push(init);
  }
  // Nodes of this outline and of the caller's are different objects: compare lines. The target's own top-level
  // ancestor (its class, or the function a nested one is in) is not a helper.
  let outer = node;
  while (outer.parent) outer = outer.parent;
  for (const n of top) if (called.has(n.name) && n.line !== node.line && n.line !== outer.line) candidates.push(n);
  if (cls) for (const n of cls.children) if (viaSelf.has(n.name) && n !== node) candidates.push(n);
  const helpers = [];
  let used = 0;
  for (const n of candidates) {
    if (helpers.some((h) => h.name === qualname(n))) continue;
    if (n.end - n.decoStart + 1 > limits.helperLines) continue;
    const body = linesOf(text, n.decoStart, n.end);
    if (used + body.length > limits.helpers) continue;
    used += body.length;
    helpers.push({ name: qualname(n), code: body });
  }
  const importsCut = cutLines(imports, limits.imports);
  return {
    imports: importsCut.text, classHeader, code: code.text, helpers,
    truncated: code.cut || importsCut.cut,
    chars: importsCut.text.length + classHeader.length + code.text.length + used,
  };
}

// ---------- docstring formats ----------
const FORMATS = ['restructuredtext', 'google', 'numpy', 'plain'];
const FORMAT_NAMES = { restructuredtext: 'reStructuredText', google: 'Google', numpy: 'NumPy', plain: 'Plain' };

// Docstrings of every def and class (and the module) in the text: [string literal source].
function docstringsOf(text) {
  const o = outline(text);
  const out = [];
  const first = o.lls[0];
  if (first && first.tokens.every((x) => x.type === 'string')) out.push(text.slice(first.tokens[0].start, first.tokens[first.tokens.length - 1].end));
  for (const n of o.nodes) {
    if (!n.docstring) continue;
    const ll = n.body[0];
    out.push(text.slice(ll.tokens[0].start, ll.tokens[ll.tokens.length - 1].end));
  }
  return out;
}

// Counts the styles of the given files' docstrings: {format | null, counts}. Epytext (@param) counts as reST,
// the closest of the formats offered.
function detectDocstringFormat(texts) {
  const counts = { restructuredtext: 0, google: 0, numpy: 0 };
  for (const text of texts) {
    let docs;
    try { docs = docstringsOf(text); } catch { continue; }
    for (const d of docs) {
      if (/^[ \t]*(?:Parameters|Returns|Yields|Raises|Attributes|Examples|Notes|See Also)[ \t]*\r?\n[ \t]*-{3,}[ \t]*$/m.test(d)) counts.numpy++;
      else if (/^[ \t]*(?:Args|Arguments|Returns|Yields|Raises|Attributes|Examples?|Note|Notes|Todo):[ \t]*\r?\n[ \t]+\S/m.test(d)) counts.google++;
      else if (/^[ \t]*[:@](?:param|type|returns?|rtype|raises?|ivar|cvar|var)\b/m.test(d)) counts.restructuredtext++;
    }
  }
  const best = Object.entries(counts).sort((a, b) => b[1] - a[1])[0];
  return { format: best[1] ? best[0] : null, counts };
}

// The quotes the file's docstrings use, '"""' when it has none.
function detectQuote(text) {
  let dq = 0;
  let sq = 0;
  for (const d of (() => { try { return docstringsOf(text); } catch { return []; } })()) {
    if (/^[rRuU]?"""/.test(d)) dq++;
    else if (/^[rRuU]?'''/.test(d)) sq++;
  }
  return sq > dq ? "'''" : '"""';
}

// Korean when the file's comments, strings or docstrings have Hangul, else English.
function detectLanguage(text) {
  for (const t of tokenize(text)) {
    if ((t.type === 'comment' || t.type === 'string') && /[가-힣ㄱ-ㆎ]/.test(text.slice(t.start, t.end))) return 'Korean';
  }
  return 'English';
}

// ---------- docstring text ----------
function stripFences(raw) {
  let t = String(raw || '').replace(/\r\n?/g, '\n').trim();
  const fence = t.match(/^```[^\n]*\n([\s\S]*?)(?:\n```[ \t]*(?:\n[\s\S]*)?$|$)/);
  if (fence) t = fence[1];
  return t;
}

function dedent(lines) {
  const ind = lines.filter((l) => l.trim()).map((l) => l.match(/^[ \t]*/)[0].length);
  const min = ind.length ? Math.min(...ind) : 0;
  return lines.map((l) => l.slice(Math.min(min, l.match(/^[ \t]*/)[0].length)));
}

// The model's answer as the docstring's text: no fences, no quotes, no indentation, no trailing blank lines.
function cleanDocstring(raw) {
  let t = stripFences(raw).trim();
  t = t.replace(/^(?:docstring|독스트링)\s*:\s*\n/i, '');
  const m = t.match(/^[rRuU]?("""|''')([\s\S]*?)\1$/);
  if (m) t = m[2];
  const lines = t.replace(/\s+$/, '').split('\n');
  const first = lines[0].trim();
  const rest = dedent(lines.slice(1)).map((l) => l.replace(/\s+$/, ''));
  while (rest.length && !rest[0].trim() && !first) rest.shift();
  return [first, ...rest].join('\n').replace(/^\n+/, '').trimEnd();
}

// The docstring's source lines at `indent`, in the file's quotes.
function formatDocstring(content, indent, quote = '"""') {
  let body = content;
  let q = quote;
  const other = q === '"""' ? "'''" : '"""';
  if (body.includes(q)) {
    if (!body.includes(other)) q = other;
    else body = body.split(q).join(q.split('').map((c) => `\\${c}`).join(''));
  }
  if (body.endsWith(q[0])) body += ' ';
  const prefix = body.includes('\\') && !body.includes(`\\${q[0]}`) ? 'r' : '';
  const lines = body.split('\n');
  if (lines.length === 1) return [`${indent}${prefix}${q}${lines[0]}${q}`];
  return [`${indent}${prefix}${q}${lines[0]}`, ...lines.slice(1).map((l) => (l.trim() ? indent + l : '')), `${indent}${q}`];
}

// Where the docstring goes for the def/class named `name` near `line`: {start, end, lines, replacing} with end =
// start - 1 for an insertion, or {error}.
function placeDocstring(text, { line, name, content, quote, indentUnit = '    ' }) {
  const node = relocate(text, line, name);
  if (!node) return { error: 'missing' };
  if (node.oneLiner) return { error: 'one-line' };
  const lines = text.split(/\r\n|\r|\n/);
  const first = node.body[0];
  const indent = first ? lines[first.line - 1].match(/^[ \t]*/)[0] : node.ws + indentUnit;
  // A replaced docstring keeps its own quotes.
  const doc = formatDocstring(content, indent, node.docstring?.quote?.length === 3 ? node.docstring.quote : quote);
  if (node.docstring) return { start: node.docstring.start, end: node.docstring.end, lines: doc, replacing: true };
  return { start: node.headerEnd + 1, end: node.headerEnd, lines: doc, replacing: false };
}

// ---------- tests ----------
const IDENT = /^[A-Za-z_]\w*$/;

// The module of `rel` (a project-relative path with / separators) for imports: {module, layout, base} or {error}.
// src layout: a file under src/ imports relative to src/.
function moduleOf(rel, { srcLayout }) {
  let parts = rel.replace(/\\/g, '/').replace(/\.pyw?$/i, '').split('/');
  let layout = 'flat';
  if (srcLayout && parts[0] === 'src' && parts.length > 1) { parts = parts.slice(1); layout = 'src'; }
  if (parts.length > 1 && parts[parts.length - 1] === '__init__') parts.pop();
  if (!parts.every((p) => IDENT.test(p))) return { error: 'not-importable', parts };
  return { module: parts.join('.'), leaf: parts[parts.length - 1], layout };
}

// How the tests import the target: the top-level name to import and the dotted path to refer to it.
function importFor(module, node) {
  let top = node;
  while (top.parent) top = top.parent;
  const nested = node.parent && node.parent.kind !== 'class';
  return { importLine: `from ${module} import ${top.name}`, name: top.name, ref: qualname(node), nested };
}

// Top-level statements of a module: [{kind: 'import'|'def'|'class'|'main'|'docstring'|'other', name?, names, start,
// end}] with 1-based line ranges (decorators and the comments right above a statement included).
function statements(text) {
  const { lls, toks } = (() => { const t = tokenize(text); return { toks: t, lls: logicalLines(text, t) }; })();
  const commentLines = new Set(toks.filter((t) => t.type === 'comment' && t.col === 0).map((t) => t.line));
  const out = [];
  let lastEnd = 0;
  for (let k = 0; k < lls.length; k++) {
    const ll = lls[k];
    if (ll.indent !== 0) continue;
    let end = ll.endLine;
    let j = k + 1;
    while (j < lls.length && lls[j].indent > 0) end = lls[j++].endLine;
    const t = ll.tokens;
    let stmt;
    if (t[0].text === '@') {
      // Decorators belong to the def/class that follows.
      let m = k;
      while (m + 1 < lls.length && lls[m].indent === 0 && lls[m].tokens[0].text === '@') m++;
      const target = lls[m];
      const tt = target.tokens;
      const at = tt[0].text === 'async' ? 1 : 0;
      let e = target.endLine;
      let q = m + 1;
      while (q < lls.length && lls[q].indent > 0) e = lls[q++].endLine;
      stmt = { kind: tt[at].text === 'class' ? 'class' : 'def', name: tt[at + 1]?.text, start: ll.line, end: e };
      k = q - 1;
    } else if (t[0].text === 'import' || t[0].text === 'from') {
      stmt = { kind: 'import', start: ll.line, end };
    } else if ((t[0].text === 'def' || t[0].text === 'class') || (t[0].text === 'async' && t[1]?.text === 'def')) {
      const at = t[0].text === 'async' ? 1 : 0;
      stmt = { kind: t[at].text === 'class' ? 'class' : 'def', name: t[at + 1]?.text, start: ll.line, end };
      k = j - 1;
    } else if (t[0].text === 'if' && t.some((x) => x.text === '__name__')) {
      stmt = { kind: 'main', start: ll.line, end };
      k = j - 1;
    } else if (!out.length && t.every((x) => x.type === 'string')) {
      stmt = { kind: 'docstring', start: ll.line, end };
    } else {
      const eq = t.findIndex((x, i) => x.text === '=' && x.depth === 0 && t[i + 1]?.text !== '=' && !'=<>!:+-*/%&|^@'.includes(t[i - 1]?.text || 'x'));
      const names = eq > 0 ? t.slice(0, eq).filter((x) => x.type === 'name').map((x) => x.text) : [];
      stmt = { kind: 'other', names, start: ll.line, end };
      k = j - 1;
    }
    // Comment lines right above (after the previous statement) go with it.
    let s = stmt.start;
    while (s - 1 > lastEnd && commentLines.has(s - 1)) s--;
    stmt.start = s;
    stmt.names ??= stmt.name ? [stmt.name] : [];
    out.push(stmt);
    lastEnd = stmt.end;
  }
  return out;
}

const normImport = (s) => s.replace(/#.*$/gm, '').replace(/[()\\]/g, ' ').replace(/,\s*$/, '').replace(/\s+/g, ' ').trim();

// Merges generated tests into the existing test file without touching what is there: new imports go after the
// existing ones, new tests are appended (before an `if __name__ == "__main__":` block), and names that already exist
// get a free suffix. The existing file keeps its line separator (the most frequent one, as the editor saves it); a new
// file, or one without any line break, gets newFileEol (Settings' "Line separator for new files").
// -> {text, added: [names], renamed: [{from, to}], imports: [lines]}
function mainSeparator(text) {
  const crlf = (text.match(/\r\n/g) || []).length;
  const cr = (text.match(/\r(?!\n)/g) || []).length;
  const lf = (text.match(/(?<!\r)\n/g) || []).length;
  if (!crlf && !cr && !lf) return null;
  // Ties go to LF, then CRLF, like the editor's detection.
  return lf >= crlf && lf >= cr ? '\n' : crlf >= cr ? '\r\n' : '\r';
}

function mergeTests(existing, generated, { newFileEol = '\n' } = {}) {
  const gen = stripFences(generated).replace(/\s+$/, '');
  const genLines = gen.split('\n');
  const gStmts = statements(gen);
  const eol = (existing && mainSeparator(existing)) || (['\n', '\r\n', '\r'].includes(newFileEol) ? newFileEol : '\n');
  const old = existing ? existing.replace(/\r\n?/g, '\n') : '';
  const oldLines = old ? old.replace(/\n$/, '').split('\n') : [];
  const oStmts = old ? statements(old) : [];
  const taken = new Set(oStmts.flatMap((s) => s.names));
  const haveImports = new Set(oStmts.filter((s) => s.kind === 'import').map((s) => normImport(oldLines.slice(s.start - 1, s.end).join('\n'))));
  const slice = (s) => genLines.slice(s.start - 1, s.end);

  const imports = [];
  for (const s of gStmts.filter((x) => x.kind === 'import')) {
    const src = slice(s).join('\n');
    if (haveImports.has(normImport(src))) continue;
    haveImports.add(normImport(src));
    imports.push(src);
  }
  const added = [];
  const renamed = [];
  const blocks = [];
  for (const s of gStmts) {
    // The file's own __main__ block (if any) stays; a generated one is only kept in a new file, which is taken as is.
    if (s.kind === 'import' || s.kind === 'docstring' || s.kind === 'main') continue;
    let lines = slice(s);
    if (s.kind === 'def' || s.kind === 'class') {
      let name = s.name;
      if (taken.has(name)) {
        for (let k = 2; ; k++) {
          const next = s.kind === 'class' ? `${s.name}${k}` : `${s.name}_${k}`;
          if (!taken.has(next)) { name = next; break; }
        }
        const re = new RegExp(`^(\\s*(?:async\\s+)?${s.kind}\\s+)${s.name}\\b`);
        const at = lines.findIndex((l) => re.test(l));
        lines = lines.map((l, i) => (i === at ? l.replace(re, `$1${name}`) : l));
        renamed.push({ from: s.name, to: name });
      }
      taken.add(name);
      added.push(name);
    } else if (s.names.length && s.names.every((n) => taken.has(n))) {
      continue; // a constant or fixture-like assignment that the file already has
    } else {
      for (const n of s.names) taken.add(n);
    }
    blocks.push({ lines });
  }
  const body = blocks;
  const join = (parts) => parts.map((p) => p.join('\n')).join('\n\n\n');

  let text;
  if (!old.trim()) {
    // A new file is the generated module as it came, so its import groups and spacing stay the model's.
    text = `${gen}\n`;
  } else {
    let lines = [...oldLines];
    // Appended blocks go before a trailing __main__ block, else at the end.
    const main = oStmts.find((s) => s.kind === 'main');
    const insertAt = main ? main.start - 1 : lines.length;
    if (body.length) {
      const before = lines.slice(0, insertAt);
      while (before.length && !before[before.length - 1].trim()) before.pop();
      const after = lines.slice(insertAt);
      const chunk = join(body.map((b) => b.lines)).split('\n');
      lines = [...before, '', '', ...chunk, ...(after.length ? ['', '', ...after] : [])];
    }
    if (imports.length) {
      const lastImport = [...oStmts].reverse().find((s) => s.kind === 'import');
      const doc = oStmts.find((s) => s.kind === 'docstring');
      const at = lastImport ? lastImport.end : doc ? doc.end : 0;
      const add = imports.join('\n').split('\n');
      const trailing = lastImport ? [] : lines[at]?.trim() === '' ? [''] : ['', ''];
      lines.splice(at, 0, ...(at && !lastImport ? ['', ...add] : add), ...trailing);
    }
    text = lines.join('\n') + '\n';
  }
  return { text: eol === '\n' ? text : text.replace(/\n/g, eol), added, renamed, imports };
}

// unittest or pytest from a test file's text: null when it says neither.
function testStyleOf(text) {
  if (/\bunittest\.TestCase\b|^\s*from\s+unittest\s+import\b.*\bTestCase\b/m.test(text)) return 'unittest';
  if (/^\s*import\s+pytest\b|^\s*from\s+pytest\b|^def\s+test_\w*\s*\(|^@pytest\./m.test(text)) return 'pytest';
  return null;
}

module.exports = {
  tokenize, logicalLines, outline, findTarget, headerAt, relocate, signature, kindOf, qualname, buildContext, LIMITS,
  FORMATS, FORMAT_NAMES, detectDocstringFormat, detectQuote, detectLanguage, cleanDocstring, formatDocstring, placeDocstring,
  moduleOf, importFor, statements, mergeTests, testStyleOf, stripFences, docstringsOf,
};
