const { spawn } = require('child_process');
const path = require('path');
const fs = require('fs');

// Runs ruff with the buffer on stdin; --stdin-filename lets ruff find the project's pyproject/ruff.toml.
function ruff(exe, args, text, file, root) {
  return new Promise((resolve) => {
    const cwd = root && fs.existsSync(root) ? root : path.dirname(file || exe);
    let p;
    try {
      p = spawn(exe, [...args, '--stdin-filename', file || 'untitled.py', '-'], { cwd, windowsHide: true });
    } catch (e) {
      return resolve({ code: -1, out: '', err: e.message });
    }
    let out = '';
    let err = '';
    // Decoded as a stream: a pipe chunk can end inside a multi-byte character (Korean text in a large file).
    p.stdout.setEncoding('utf8');
    p.stderr.setEncoding('utf8');
    p.stdout.on('data', (d) => (out += d));
    p.stderr.on('data', (d) => (err += d));
    p.on('error', (e) => resolve({ code: -1, out, err: e.message }));
    p.on('close', (code) => resolve({ code, out, err }));
    // A missing or blocked ruff.exe also fails the stdin write (EOF/EPIPE); unhandled, that throws in the main process.
    p.stdin.on('error', () => {});
    p.stdin.end(text, 'utf8');
  });
}

const lineLengthArgs = (opts) => (opts?.lineLength ? ['--line-length', String(opts.lineLength)] : []);
const readText = (file) => { try { return fs.readFileSync(file, 'utf8'); } catch { return ''; } };
// Bundled ruff's default rule set includes isort (I001), which flags nearly every file; without a project config,
// fall back to ruff's classic defaults, which match what PyCharm's own inspections report.
const hasRuffConfig = (root) => !!root && (['ruff.toml', '.ruff.toml'].some((f) => fs.existsSync(path.join(root, f)))
  || /^\[tool\.ruff/m.test(readText(path.join(root, 'pyproject.toml'))));
const lintRuleArgs = (opts) => (hasRuffConfig(opts?.root) ? [] : ['--select', 'E4,E7,E9,F']);
// Why ruff stopped (exit code 2: a configuration it cannot read, a file it cannot parse; -1: it did not start), from
// its stderr: "ruff failed" and a chain of "Cause:" lines, a source excerpt, and the detail last. -> {error, config?,
// line?, col?}: config is the configuration file at fault, line/col the place in it.
function failure(err, root) {
  const lines = err.split(/\r?\n/);
  let causes = lines.filter((l) => /^\s*Cause:/.test(l)).map((l) => l.replace(/^\s*Cause:\s*/, ''));
  const rest = lines.map((l) => l.trim()).filter((l) => l && !/^ruff failed$|^Cause:|^warning:/i.test(l) && !/^(\d+\s*)?\|/.test(l));
  const named = causes.join('\n').match(/`([^`]+\.toml)`|Failed to parse (\S+\.toml)$/m);
  const config = named ? path.resolve(root || '', named[1] || named[2]) : null;
  if (causes.length > 1) causes = causes.filter((c) => !/^Failed to load configuration/.test(c));
  let error = [...causes, ...rest.map((l) => l.replace(/^error:\s*/i, ''))].join(': ') || err.trim();
  if (config) error = error.split(config).join(root ? path.relative(root, config) : path.basename(config));
  const at = /TOML parse error at line (\d+), column (\d+)/.exec(error);
  return { error, ...(config ? { config } : {}), ...(at ? { line: Number(at[1]), col: Number(at[2]) } : {}) };
}
const firstError = (err, root) => failure(err, root).error;

exports.register = ({ ipcMain, startProcess, vendorDir }) => {
  const exe = path.join(vendorDir, 'bin', 'ruff.exe');

  // opts: {root, lineLength, range: 'l:c-l:c'} -> {ok, text} | {ok: false, error}
  ipcMain.handle('tooling:format', async (_e, text, file, opts = {}) => {
    const args = ['format', ...lineLengthArgs(opts), ...(opts.range ? ['--range', opts.range] : [])];
    const r = await ruff(exe, args, text, file, opts.root);
    return r.code === 0 ? { ok: true, text: r.out } : { ok: false, error: firstError(r.err, opts.root) };
  });

  // PyCharm's Optimize Imports sorts and also drops unused imports, hence I + F401.
  ipcMain.handle('tooling:optimizeImports', async (_e, text, file, opts = {}) => {
    const r = await ruff(exe, ['check', '--select', 'I,F401', '--fix', '--exit-zero', '--quiet', ...lineLengthArgs(opts)], text, file, opts.root);
    return r.code === 0 ? { ok: true, text: r.out } : { ok: false, error: firstError(r.err, opts.root) };
  });

  ipcMain.handle('tooling:fixAll', async (_e, text, file, opts = {}) => {
    const r = await ruff(exe, ['check', '--fix', '--exit-zero', '--quiet', ...lintRuleArgs(opts), ...lineLengthArgs(opts)], text, file, opts.root);
    return r.code === 0 ? { ok: true, text: r.out } : { ok: false, error: firstError(r.err, opts.root) };
  });

  // -> [{code, message, location: {row, column}, end_location, fix: {message, edits}, noqa_row}], or {error, config?,
  // line?, col?} when ruff could not check the file (with --exit-zero, any exit code but 0 is a failure, not findings).
  ipcMain.handle('tooling:check', async (_e, text, file, opts = {}) => {
    const r = await ruff(exe, ['check', '--output-format', 'json', '--exit-zero', ...lintRuleArgs(opts), ...lineLengthArgs(opts)], text, file, opts.root);
    if (r.code !== 0) return failure(r.err || `ruff exited with code ${r.code}`, opts.root);
    try { return JSON.parse(r.out); } catch { return []; }
  });

  ipcMain.handle('tooling:ruffVersion', async () => (await ruff(exe, ['--version'], '', null)).out.trim());

  ipcMain.handle('tooling:createVenv', (_e, interp, dir) => {
    fs.mkdirSync(path.dirname(dir), { recursive: true });
    return startProcess(interp.cmd, [...interp.args, '-m', 'venv', dir], { cwd: path.dirname(dir) });
  });
};
