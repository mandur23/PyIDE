// AI actions on the def or class at the caret: Write Documentation (a docstring in the project's format) and Generate
// Unit Tests (tests/test_<module>.py). Like ai-edit and ai-chat, every model call goes through the Claude Code CLI
// (main/ai/claude.js); tests swap the CLI with PYIDE_CLAUDE_PATH. Source analysis and text assembly are in
// main/ai/generate-text.js. Only the target's code, its class header, the module's imports and small helpers it calls
// are sent; the IDE log shows the prompt at DEBUG level.
const fs = require('fs');
const path = require('path');
const { complete } = require('../ai/claude');
const trust = require('../trust');
const log = require('../diagnostics').logger('#ai-generate');
const G = require('../ai/generate-text');
const codec = require('../text-codec');

const DOC_SYSTEM = `You write Python docstrings inside a Python IDE.
Reply with only the docstring's text: no quotes around it, no indentation, no code fences, no code, nothing before or after it.
Start with a one-line summary that ends with a period. Describe what the code does from its signature, type hints, body and the exceptions it raises.
Use the requested docstring format:
- reStructuredText: ":param name: description" for each parameter, ":type name: type" only for parameters without a type hint, ":return: description", ":rtype: type" only without a return annotation, ":raises ErrorName: when".
- Google: "Args:", "Returns:" (or "Yields:" for a generator) and "Raises:" sections, entries indented by four spaces as "name (type): description"; leave out "(type)" for parameters with a type hint.
- NumPy: "Parameters", "Returns" (or "Yields") and "Raises" sections, each underlined with dashes, entries "name : type" with the description indented by four spaces on the next line.
- Plain: the summary and, if it helps, a short description, without sections.
For a class, describe what it represents and document the parameters of __init__ (and public attributes in Google's "Attributes:").
Leave out sections that would be empty. Do not document self or cls.
Write the text in the language given in the request; keep code identifiers as they are.`;

const TESTS_SYSTEM = `You write unit tests for Python code inside a Python IDE.
Reply with only the contents of a Python test module: the imports it needs, then the tests. No code fences, no explanation before or after it.
Use the framework given in the request: pytest (plain test functions, pytest.raises, pytest.mark.parametrize where it helps) or unittest (a unittest.TestCase subclass).
Import the code under test exactly as the request says; never copy or redefine it in the test module.
Cover the normal behaviour and the edge cases: boundary values, empty inputs, None where it is allowed, and every exception the code raises.
Tests must be deterministic and must not use the network, the current time, or files outside a temporary directory (pytest's tmp_path).
Give every test a descriptive name starting with test_, and do not reuse the names listed as existing.
Write comments and test strings in the language given in the request.`;

// Claude Code model ids and aliases; the value ends up on a command line.
const MODEL_ID = /^[\w.\-[\]]+$/;
const SKIP_DIRS = new Set(['.git', '.hg', '.svn', 'node_modules', '__pycache__', 'site-packages', '.tox', '.nox', '.mypy_cache',
  '.pytest_cache', '.ruff_cache', '.idea', '.vscode', 'build', 'dist', '.eggs']);
const isVenvDir = (name) => /^\.?venv/i.test(name) || /^\.?env$/i.test(name);

const relPosix = (root, p) => path.relative(root, p).replace(/\\/g, '/');
const readText = (p, max = 256 * 1024) => {
  try {
    const fd = fs.openSync(p, 'r');
    const buf = Buffer.alloc(Math.min(max, fs.fstatSync(fd).size));
    const n = fs.readSync(fd, buf, 0, buf.length, 0);
    fs.closeSync(fd);
    return buf.subarray(0, n).toString('utf8').replace(/^﻿/, '');
  } catch { return null; }
};

// An existing test file as the editor reads it (encoding detected like fs:readText). It is written back in that
// encoding, so it is merged only when that gives back exactly its bytes; a file over MAX_TEST_FILE is refused rather
// than cut. -> {text: null} (no file) | {text, encoding} | {code: 'too-large' | 'unreadable' | 'encoding', encoding?}
const MAX_TEST_FILE = 4 * 1024 * 1024;
function readTestFile(p) {
  let buf;
  try {
    if (!fs.existsSync(p)) return { text: null };
    if (fs.statSync(p).size > MAX_TEST_FILE) return { code: 'too-large' };
    buf = fs.readFileSync(p);
  } catch { return { code: 'unreadable' }; }
  const encoding = codec.detect(buf);
  if (!encoding.startsWith('utf-16') && codec.looksBinary(buf)) return { code: 'unreadable' };
  const text = codec.decode(buf, encoding);
  if (!codec.encode(text, encoding).equals(buf)) return { code: 'encoding', encoding };
  return { text, encoding };
}
// `after` in the file's encoding, or null when it has characters the encoding cannot hold.
function encodeTests(after, encoding) {
  const buf = codec.encode(after, encoding);
  return codec.decode(buf, encoding) === after ? buf : null;
}

// Up to `limit` .py files under root (breadth first, no virtual environments or caches).
async function pythonFiles(root, limit = 150, filter = () => true) {
  const out = [];
  const queue = [[root, 0]];
  while (queue.length && out.length < limit) {
    const [dir, depth] = queue.shift();
    let entries;
    try { entries = await fs.promises.readdir(dir, { withFileTypes: true }); } catch { continue; }
    entries.sort((a, b) => a.name.localeCompare(b.name));
    for (const e of entries) {
      const p = path.join(dir, e.name);
      if (e.isDirectory()) {
        if (depth < 6 && !SKIP_DIRS.has(e.name) && !isVenvDir(e.name) && !fs.existsSync(path.join(p, 'pyvenv.cfg'))) queue.push([p, depth + 1]);
      } else if (/\.pyw?$/i.test(e.name) && filter(p) && out.length < limit) out.push(p);
    }
  }
  return out;
}

// ---------- docstring format ----------
const formatCache = new Map(); // root -> {at, result}

async function docstringFormat(root, text, setting) {
  if (G.FORMATS.includes(setting)) return { format: setting, source: 'setting' };
  const own = G.detectDocstringFormat([text]);
  if (own.format) return { format: own.format, source: 'detected', counts: own.counts };
  let cached = formatCache.get(root);
  if (!cached || Date.now() - cached.at > 60000) {
    const texts = [];
    for (const f of await pythonFiles(root)) { const t = readText(f, 100 * 1024); if (t) texts.push(t); }
    cached = { at: Date.now(), result: G.detectDocstringFormat(texts) };
    formatCache.set(root, cached);
  }
  if (cached.result.format) return { format: cached.result.format, source: 'detected', counts: cached.result.counts };
  // PyCharm's default docstring format.
  return { format: 'restructuredtext', source: 'default' };
}

// ---------- test framework and layout ----------
const has = (p, re) => { const t = readText(p, 64 * 1024); return t !== null && re.test(t); };

function pytestConfigured(root) {
  return fs.existsSync(path.join(root, 'pytest.ini')) || fs.existsSync(path.join(root, 'conftest.py'))
    || has(path.join(root, 'pyproject.toml'), /^\[tool\.pytest/m) || has(path.join(root, 'setup.cfg'), /^\[tool:pytest\]/m)
    || has(path.join(root, 'tox.ini'), /^\[pytest\]/m);
}

// 'unittest' only when the test file, or else most of the project's test files, use unittest.TestCase.
async function testFramework(root, testsDir, testFile) {
  const own = fs.existsSync(testFile) ? G.testStyleOf(readText(testFile) || '') : null;
  if (own) return { framework: own, source: 'file' };
  if (pytestConfigured(root) || fs.existsSync(path.join(testsDir, 'conftest.py'))) return { framework: 'pytest', source: 'config' };
  let unit = 0;
  let py = 0;
  const files = await pythonFiles(root, 60, (p) => /(^test_.*|_test)\.py$/i.test(path.basename(p)));
  for (const f of files) {
    const style = G.testStyleOf(readText(f, 64 * 1024) || '');
    if (style === 'unittest') unit++; else if (style === 'pytest') py++;
  }
  if (unit > py) return { framework: 'unittest', source: 'tests' };
  return { framework: 'pytest', source: py ? 'tests' : 'default' };
}

// Whether tests can import from src/ in a src-layout project: pytest's pythonpath, a conftest that adds it, or an
// editable install the IDE cannot see (then the note stays).
function srcOnPath(root, testsDir) {
  const re = /pythonpath\s*=\s*[^\n]*\bsrc\b/i;
  return ['pyproject.toml', 'pytest.ini', 'setup.cfg', 'tox.ini'].some((f) => has(path.join(root, f), re))
    || [path.join(root, 'conftest.py'), path.join(testsDir, 'conftest.py')].some((f) => has(f, /\bsrc\b/));
}

// Where the tests for `file` go and how they import it.
async function testPlan(root, file, text, line) {
  const node = G.findTarget(text, line);
  if (!node) return { ok: false, code: 'no-target' };
  const rel = relPosix(root, file);
  if (!rel || rel.startsWith('..') || path.isAbsolute(rel)) return { ok: false, code: 'outside' };
  const srcLayout = fs.existsSync(path.join(root, 'src')) && rel.startsWith('src/');
  const mod = G.moduleOf(rel, { srcLayout });
  if (mod.error) return { ok: false, code: 'not-importable', message: rel };
  const testsDir = fs.existsSync(path.join(root, 'tests')) || !fs.existsSync(path.join(root, 'test')) ? path.join(root, 'tests') : path.join(root, 'test');
  const testPath = path.join(testsDir, `test_${mod.leaf}.py`);
  if (path.resolve(testPath) === path.resolve(file)) return { ok: false, code: 'is-test' };
  const fw = await testFramework(root, testsDir, testPath);
  const imp = G.importFor(mod.module, node);
  const notes = [];
  if (mod.layout === 'src' && !srcOnPath(root, testsDir)) notes.push('src-path');
  if (imp.nested) notes.push('nested');
  // unittest discovery only enters packages, so a new tests folder gets an __init__.py.
  const createInit = fw.framework === 'unittest' && !fs.existsSync(testsDir);
  return {
    ok: true, node, testPath, testRel: relPosix(root, testPath), exists: fs.existsSync(testPath), module: mod.module, layout: mod.layout,
    framework: fw.framework, frameworkSource: fw.source, importLine: imp.importLine, ref: imp.ref, notes, createInit,
    name: node.name, qualname: G.qualname(node), kind: G.kindOf(node),
  };
}

// ---------- prompts ----------
function contextParts(rel, node, sig, ctx) {
  const parts = [`Target: ${sig.kind} ${sig.qualname}`, `Signature (JSON): ${JSON.stringify(sig)}`, `File: ${rel}`, ''];
  if (ctx.imports) parts.push('Module imports:', '<imports>', ctx.imports, '</imports>', '');
  if (ctx.classHeader) parts.push('The class it belongs to:', '<class>', ctx.classHeader, '</class>', '');
  if (ctx.helpers.length) {
    parts.push('Helpers it uses, for reference:');
    for (const h of ctx.helpers) parts.push(`<helper name="${h.name}">`, h.code, '</helper>');
    parts.push('');
  }
  return parts;
}

function docPrompt({ rel, node, sig, ctx, format, language }) {
  return [
    'Task: write the docstring',
    `Docstring format: ${G.FORMAT_NAMES[format]}`,
    `Language: ${language}`,
    ...contextParts(rel, node, sig, ctx),
    `Write the docstring for this ${sig.kind}${node.docstring ? ' (it replaces the current one)' : ''}:`,
    '<code>', ctx.code, '</code>',
  ].join('\n');
}

function testsPrompt({ rel, node, sig, ctx, plan, existingNames, language }) {
  return [
    'Task: write unit tests',
    `Framework: ${plan.framework}`,
    `Test file: ${plan.testRel}`,
    `Import: ${plan.importLine}`,
    `Refer to it as: ${plan.ref}`,
    `Existing tests in the file (do not reuse these names): ${existingNames.length ? existingNames.join(', ') : '(none)'}`,
    `Language: ${language}`,
    ...contextParts(rel, node, sig, ctx),
    `Write tests for this ${sig.kind}:`,
    '<code>', ctx.code, '</code>',
  ].join('\n');
}

exports.register = ({ ipcMain }) => {
  const running = new Map(); // reqId -> AbortController

  async function run(reqId, { system, prompt, model, timeoutMs }) {
    if (!MODEL_ID.test(model)) return { ok: false, code: 'cli', message: `invalid model name "${model}"` };
    const ctl = new AbortController();
    running.set(reqId, ctl);
    let timedOut = false;
    const timer = setTimeout(() => { timedOut = true; ctl.abort(); }, timeoutMs);
    try {
      return { ok: true, ...(await complete({ system, prompt, model, signal: ctl.signal })) };
    } catch (err) {
      if (timedOut) return { ok: false, code: 'timeout', message: 'Claude Code did not answer in time' };
      return { ok: false, code: err.code || 'cli', message: err.message };
    } finally {
      clearTimeout(timer);
      running.delete(reqId);
    }
  }

  const refuse = (root) => (!root || !trust.isTrusted(root) ? { ok: false, code: 'untrusted', message: 'the project is not trusted' } : null);
  const sent = (what, rel, qn, model, prompt) => log.debug(`${what} for ${rel}:${qn}: sent ${prompt.length} characters to Claude Code (${model})\n${prompt}`);

  // The def/class at the caret, for the renderer: null when there is none.
  ipcMain.handle('ai-generate:analyze', (_e, { text, line, header }) => {
    const node = header ? G.headerAt(text, line) : G.findTarget(text, line);
    if (!node) return null;
    return { name: node.name, qualname: G.qualname(node), kind: G.kindOf(node), line: node.line, headerEnd: node.headerEnd,
      end: node.end, hasDocstring: !!node.docstring, oneLiner: node.oneLiner };
  });

  // req: {reqId, root, path, text, line, model, format ('' = detect)} -> {ok, content, format, formatSource, quote, language, chars}
  ipcMain.handle('ai-generate:docstring', async (_e, req) => {
    const no = refuse(req.root);
    if (no) return no;
    const node = G.findTarget(req.text, req.line);
    if (!node) return { ok: false, code: 'no-target' };
    if (node.oneLiner) return { ok: false, code: 'one-line' };
    const rel = relPosix(req.root, req.path);
    const sig = G.signature(req.text, node);
    const ctx = G.buildContext(req.text, node, { purpose: 'docstring' });
    const fmt = await docstringFormat(req.root, req.text, req.format);
    const language = G.detectLanguage(req.text);
    const prompt = docPrompt({ rel, node, sig, ctx, format: fmt.format, language });
    sent('Write Documentation', rel, sig.qualname, req.model, prompt);
    const r = await run(req.reqId, { system: DOC_SYSTEM, prompt, model: req.model, timeoutMs: 180000 });
    if (!r.ok) return r;
    const content = G.cleanDocstring(r.text);
    if (!content) return { ok: false, code: 'empty', message: 'Claude Code returned no docstring' };
    return { ok: true, content, format: fmt.format, formatSource: fmt.source, quote: G.detectQuote(req.text), language,
      chars: prompt.length, name: node.name, line: node.line, ms: r.ms };
  });

  // Places a docstring into the current text: {start, end, lines, replacing} or {error}.
  ipcMain.handle('ai-generate:place', (_e, req) => G.placeDocstring(req.text, req));

  // req: {root, path, text, line} -> the test plan without the model call (so the renderer can pass an open test file's text).
  ipcMain.handle('ai-generate:planTests', async (_e, req) => {
    const no = refuse(req.root);
    if (no) return no;
    const plan = await testPlan(req.root, req.path, req.text, req.line);
    if (!plan.ok) return plan;
    const { node, ...rest } = plan;
    return rest;
  });

  // req: {reqId, root, path, text, line, model, existingText?, newFileSeparator?}
  // -> {ok, testPath, testRel, before, after, encoding, added, renamed, ...plan}
  // existingText is an open test document's text (the editor saves it in its own encoding); otherwise the file on disk.
  ipcMain.handle('ai-generate:tests', async (_e, req) => {
    const no = refuse(req.root);
    if (no) return no;
    const plan = await testPlan(req.root, req.path, req.text, req.line);
    if (!plan.ok) return plan;
    const fail = (code, encoding) => ({ ok: false, code, encoding, testPath: plan.testPath, testRel: plan.testRel });
    let before = null;
    let encoding = null;
    if (typeof req.existingText === 'string') before = req.existingText;
    else if (plan.exists) {
      const f = readTestFile(plan.testPath);
      if (f.code) return fail(f.code, f.encoding);
      ({ text: before, encoding } = f);
    }
    const existingNames = before ? G.statements(before.replace(/\r\n?/g, '\n')).filter((s) => s.kind === 'def' || s.kind === 'class').map((s) => s.name) : [];
    const rel = relPosix(req.root, req.path);
    const sig = G.signature(req.text, plan.node);
    const ctx = G.buildContext(req.text, plan.node, { purpose: 'tests' });
    const language = G.detectLanguage(req.text);
    const prompt = testsPrompt({ rel, node: plan.node, sig, ctx, plan, existingNames, language });
    sent('Generate Unit Tests', rel, sig.qualname, req.model, prompt);
    const r = await run(req.reqId, { system: TESTS_SYSTEM, prompt, model: req.model, timeoutMs: 300000 });
    if (!r.ok) return r;
    const merged = G.mergeTests(before, r.text, { newFileEol: req.newFileSeparator });
    if (!merged.added.length) return { ok: false, code: 'empty', message: 'Claude Code returned no tests' };
    if (encoding && !encodeTests(merged.text, encoding)) return fail('unencodable', encoding);
    const { node, ...rest } = plan;
    return { ...rest, ok: true, before, after: merged.text, encoding, added: merged.added, renamed: merged.renamed, importsAdded: merged.imports,
      chars: prompt.length, ms: r.ms };
  });

  // Writes the previewed test file, only if it is still what the preview was made from, in the file's own encoding
  // (a new file is UTF-8).
  ipcMain.handle('ai-generate:writeTests', (_e, { root, testPath, before, after, createInit }) => {
    const no = refuse(root);
    if (no) return no;
    const rel = relPosix(root, testPath);
    if (!rel || rel.startsWith('..') || path.isAbsolute(rel) || !/\.py$/i.test(testPath) || typeof after !== 'string') return { ok: false, code: 'outside' };
    const now = readTestFile(testPath);
    if (now.code) return { ok: false, code: now.code, encoding: now.encoding };
    if (now.text !== (before ?? null)) return { ok: false, code: 'changed' };
    const encoding = now.text === null ? 'utf-8' : now.encoding;
    const buf = encodeTests(after, encoding);
    if (!buf) return { ok: false, code: 'unencodable', encoding };
    fs.mkdirSync(path.dirname(testPath), { recursive: true });
    const init = path.join(path.dirname(testPath), '__init__.py');
    if (createInit && !fs.existsSync(init)) fs.writeFileSync(init, '', 'utf8');
    fs.writeFileSync(testPath, buf);
    log.info(`Generate Unit Tests: wrote ${rel}`);
    return { ok: true };
  });

  ipcMain.handle('ai-generate:cancel', (_e, reqId) => { running.get(reqId)?.abort(); });
};

exports.docPrompt = docPrompt;
exports.testsPrompt = testsPrompt;
exports.testPlan = testPlan;
exports.readTestFile = readTestFile;
exports.encodeTests = encodeTests;
exports.MAX_TEST_FILE = MAX_TEST_FILE;
