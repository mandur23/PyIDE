// Prettier and ESLint for JavaScript and TypeScript projects, as WebStorm and VS Code run them: the project's own
// packages (node_modules/prettier, node_modules/eslint, found from the file's folder up to the project root), nothing
// the IDE downloads, run by the IDE's own Electron as Node (ELECTRON_RUN_AS_NODE), so no Node on PATH is needed. Only
// in trusted projects: their CLIs and configuration files (eslint.config.js, .prettierrc.js) are code the project
// ships.
const { spawn } = require('child_process');
const fs = require('fs');
const path = require('path');
const { isTrusted } = require('../trust');

const TIMEOUT_MS = 30000;
const isFile = (p) => { try { return fs.statSync(p).isFile(); } catch { return false; } };
const readJson = (p) => { try { return JSON.parse(fs.readFileSync(p, 'utf8')); } catch { return null; } };
const norm = (p) => path.resolve(p).replace(/[\\/]+$/, '').toLowerCase();
const isUnder = (p, root) => norm(p) === norm(root) || norm(p).startsWith(norm(root) + path.sep);

// The folders from the file's own up to the project root, nearest first; none for a file outside the root.
function foldersUp(file, root) {
  if (!file || !root || !path.isAbsolute(file) || !isUnder(file, root)) return [];
  const out = [];
  for (let dir = path.dirname(path.resolve(file)); ; dir = path.dirname(dir)) {
    out.push(dir);
    if (norm(dir) === norm(root) || path.dirname(dir) === dir) break;
  }
  return out;
}

// The nearest installed package `name`: {dir (the folder holding node_modules), version, bin (its CLI script)}, or
// null. The CLI is the package.json's bin entry, which must stay inside the package.
function findPackage(name, file, root, fallbackBin) {
  for (const dir of foldersUp(file, root)) {
    const pkgDir = path.join(dir, 'node_modules', name);
    const pkg = readJson(path.join(pkgDir, 'package.json'));
    if (!pkg) continue;
    const rel = typeof pkg.bin === 'string' ? pkg.bin : pkg.bin?.[name] || fallbackBin;
    const bin = path.resolve(pkgDir, rel);
    if (!isUnder(bin, pkgDir) || !isFile(bin)) continue;
    return { dir, version: String(pkg.version || ''), bin };
  }
  return null;
}

const FLAT_CONFIGS = ['eslint.config.js', 'eslint.config.mjs', 'eslint.config.cjs', 'eslint.config.ts', 'eslint.config.mts', 'eslint.config.cts'];
const LEGACY_CONFIGS = ['.eslintrc.js', '.eslintrc.cjs', '.eslintrc.yaml', '.eslintrc.yml', '.eslintrc.json', '.eslintrc'];
// The ESLint configuration that applies to the file: {kind: 'flat' | 'legacy', dir}, or null when there is none (a
// project with ESLint installed but not set up is not linted, rather than failing on every file).
function findEslintConfig(file, root) {
  for (const dir of foldersUp(file, root)) {
    if (FLAT_CONFIGS.some((f) => isFile(path.join(dir, f)))) return { kind: 'flat', dir };
    if (LEGACY_CONFIGS.some((f) => isFile(path.join(dir, f))) || readJson(path.join(dir, 'package.json'))?.eslintConfig) return { kind: 'legacy', dir };
  }
  return null;
}

// Runs a package's CLI with `text` on stdin -> {code, out, err}; code -1 when it did not start or timed out.
function runCli(bin, args, text, cwd, extraEnv = {}) {
  return new Promise((resolve) => {
    let p;
    try {
      p = spawn(process.execPath, [bin, ...args], {
        cwd, windowsHide: true, env: { ...process.env, ELECTRON_RUN_AS_NODE: '1', ...extraEnv },
      });
    } catch (e) {
      return resolve({ code: -1, out: '', err: e.message });
    }
    let out = '';
    let err = '';
    let done = false;
    const finish = (r) => { if (!done) { done = true; clearTimeout(timer); resolve(r); } };
    const timer = setTimeout(() => {
      try { p.kill(); } catch {}
      finish({ code: -1, out: '', err: `timed out after ${TIMEOUT_MS / 1000} s` });
    }, TIMEOUT_MS);
    p.stdout.setEncoding('utf8');
    p.stderr.setEncoding('utf8');
    p.stdout.on('data', (d) => (out += d));
    p.stderr.on('data', (d) => (err += d));
    p.on('error', (e) => finish({ code: -1, out, err: e.message }));
    p.on('close', (code) => finish({ code, out, err }));
    p.stdin.on('error', () => {});
    p.stdin.end(text, 'utf8');
  });
}

// Prettier's message for a file it cannot format: the first "[error]" line without its prefix and the file name it
// starts with ("[error] src/a.js: SyntaxError: Unexpected token (1:17)" -> "SyntaxError: Unexpected token (1:17)").
function prettierError(err, file) {
  const lines = err.split(/\r?\n/).map((l) => l.replace(/^\[error\]\s?/, '')).filter((l) => l.trim());
  let first = lines.find((l) => !/^\s*(>?\s*\d+\s*\||\|)/.test(l)) || lines[0] || '';
  const name = path.basename(file || '');
  const at = first.indexOf(': ');
  if (at > 0 && path.basename(first.slice(0, at).trim()) === name) first = first.slice(at + 2);
  return first.trim() || 'Prettier failed';
}

// ESLint's message when it cannot lint at all (exit code 2): "Oops! Something went wrong! :(", "ESLint: 9.1.0", then
// the error and its stack. Only the error, and its first lines.
function eslintError(err) {
  const lines = err.split(/\r?\n/).map((l) => l.trim())
    .filter((l) => l && !/^Oops! Something went wrong!/.test(l) && !/^ESLint: \S+$/.test(l) && !/^at\s/.test(l));
  return lines.slice(0, 3).join(' ') || 'ESLint failed';
}

// Messages about the file itself rather than its code: an ignored file is linted as if it were clean.
const ignoredNotice = (m) => !m.ruleId && m.severity === 1 && /^File ignored\b/.test(m.message || '');

exports.register = ({ ipcMain }) => {
  const refuse = (root) => (!root || !isTrusted(root) ? { skipped: 'untrusted' } : null);

  // -> {prettier: version | null, eslint: version | null, eslintConfig: 'flat' | 'legacy' | null} | {skipped}
  ipcMain.handle('js-tools:status', (_e, file, root) => refuse(root) || {
    prettier: findPackage('prettier', file, root, 'bin/prettier.cjs')?.version ?? null,
    eslint: findPackage('eslint', file, root, 'bin/eslint.js')?.version ?? null,
    eslintConfig: findEslintConfig(file, root)?.kind ?? null,
  });

  // The file's text formatted by the project's Prettier, with its path so its .prettierrc and .prettierignore apply.
  // -> {text, version} | {error} | null (no Prettier in the project) | {skipped: 'untrusted'}
  ipcMain.handle('js-tools:prettier', async (_e, text, file, root) => {
    const no = refuse(root);
    if (no) return no;
    const pkg = findPackage('prettier', file, root, 'bin/prettier.cjs');
    if (!pkg) return null;
    const r = await runCli(pkg.bin, ['--stdin-filepath', file], String(text ?? ''), pkg.dir);
    if (r.code === 0) return { text: r.out, version: pkg.version };
    return { error: prettierError(r.err || r.out || `Prettier exited with code ${r.code}`, file) };
  });

  // The project's ESLint on the file's text. fix: also the text with every fix applied (--fix-dry-run), as `output`.
  // -> {messages: [{ruleId, severity, message, line, column, endLine?, endColumn?, fix?, suggestions?}], output?, version}
  // | {error} (ESLint could not lint: a configuration it cannot load, a crash) | null (no ESLint or no configuration)
  // | {skipped: 'untrusted'}
  ipcMain.handle('js-tools:eslint', async (_e, text, file, root, opts = {}) => {
    const no = refuse(root);
    if (no) return no;
    const pkg = findPackage('eslint', file, root, 'bin/eslint.js');
    const config = pkg && findEslintConfig(file, root);
    if (!config) return null;
    const args = ['--format', 'json', '--stdin', '--stdin-filename', file, ...(opts.fix ? ['--fix-dry-run'] : [])];
    // ESLint 9 reads .eslintrc* only when told to; ESLint 8 finds eslint.config.* itself.
    const env = config.kind === 'legacy' ? { ESLINT_USE_FLAT_CONFIG: 'false' } : {};
    // ESLint looks for eslint.config.* from its working folder up.
    const cwd = config.kind === 'flat' ? config.dir : pkg.dir;
    const r = await runCli(pkg.bin, args, String(text ?? ''), cwd, env);
    let results = null;
    try { results = JSON.parse(r.out); } catch {}
    if (r.code > 1 || r.code < 0 || !Array.isArray(results)) {
      return { error: eslintError(r.err || r.out || `ESLint exited with code ${r.code}`) };
    }
    const result = results[0] || { messages: [] };
    const messages = (result.messages || []).filter((m) => !ignoredNotice(m)).map((m) => ({
      ruleId: m.ruleId || null, severity: m.severity === 2 ? 2 : 1, message: String(m.message || ''), fatal: !!m.fatal,
      line: m.line || 1, column: m.column || 1, endLine: m.endLine, endColumn: m.endColumn,
      ...(m.fix ? { fix: m.fix } : {}), ...(m.suggestions?.length ? { suggestions: m.suggestions } : {}),
    }));
    return { messages, ...(typeof result.output === 'string' ? { output: result.output } : {}), version: pkg.version };
  });
};

Object.assign(exports, { findPackage, findEslintConfig, prettierError, eslintError });
