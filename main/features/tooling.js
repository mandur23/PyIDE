const { spawn } = require('child_process');
const path = require('path');
const fs = require('fs');

// Runs ruff with the buffer on stdin; --stdin-filename lets ruff find the project's pyproject/ruff.toml.
function ruff(exe, args, text, file, root) {
  return new Promise((resolve) => {
    const cwd = root && fs.existsSync(root) ? root : path.dirname(file || exe);
    let p;
    try {
      p = spawn(exe, [...args, '--stdin-filename', file || 'untitled.py', '-'], { cwd });
    } catch (e) {
      return resolve({ code: -1, out: '', err: e.message });
    }
    let out = '';
    let err = '';
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
// Bundled ruff's default rule set includes isort (I001), which flags nearly every file; without a project config,
// fall back to ruff's classic defaults, which match what PyCharm's own inspections report.
const hasRuffConfig = (root) => !!root && (['ruff.toml', '.ruff.toml'].some((f) => fs.existsSync(path.join(root, f)))
  || (fs.existsSync(path.join(root, 'pyproject.toml')) && /^\[tool\.ruff/m.test(fs.readFileSync(path.join(root, 'pyproject.toml'), 'utf8'))));
const lintRuleArgs = (opts) => (hasRuffConfig(opts?.root) ? [] : ['--select', 'E4,E7,E9,F']);
const firstError =(err) => err.split(/\r?\n/).find((l) => /error/i.test(l))?.replace(/^error:\s*/i, '') || err.trim();

exports.register = ({ ipcMain, startProcess, vendorDir }) => {
  const exe = path.join(vendorDir, 'bin', 'ruff.exe');

  // opts: {root, lineLength, range: 'l:c-l:c'} -> {ok, text} | {ok: false, error}
  ipcMain.handle('tooling:format', async (_e, text, file, opts = {}) => {
    const args = ['format', ...lineLengthArgs(opts), ...(opts.range ? ['--range', opts.range] : [])];
    const r = await ruff(exe, args, text, file, opts.root);
    return r.code === 0 ? { ok: true, text: r.out } : { ok: false, error: firstError(r.err) };
  });

  // PyCharm's Optimize Imports sorts and also drops unused imports, hence I + F401.
  ipcMain.handle('tooling:optimizeImports', async (_e, text, file, opts = {}) => {
    const r = await ruff(exe, ['check', '--select', 'I,F401', '--fix', '--exit-zero', '--quiet', ...lineLengthArgs(opts)], text, file, opts.root);
    return r.code === 0 ? { ok: true, text: r.out } : { ok: false, error: firstError(r.err) };
  });

  ipcMain.handle('tooling:fixAll', async (_e, text, file, opts = {}) => {
    const r = await ruff(exe, ['check', '--fix', '--exit-zero', '--quiet', ...lintRuleArgs(opts), ...lineLengthArgs(opts)], text, file, opts.root);
    return r.code === 0 ? { ok: true, text: r.out } : { ok: false, error: firstError(r.err) };
  });

  // -> [{code, message, location: {row, column}, end_location, fix: {message, edits}, noqa_row}]
  ipcMain.handle('tooling:check', async (_e, text, file, opts = {}) => {
    const r = await ruff(exe, ['check', '--output-format', 'json', '--exit-zero', ...lintRuleArgs(opts), ...lineLengthArgs(opts)], text, file, opts.root);
    try { return JSON.parse(r.out); } catch { return []; }
  });

  ipcMain.handle('tooling:ruffVersion', async () => (await ruff(exe, ['--version'], '', null)).out.trim());

  ipcMain.handle('tooling:createVenv', (_e, interp, dir) => {
    fs.mkdirSync(path.dirname(dir), { recursive: true });
    return startProcess(interp.cmd, [...interp.args, '-m', 'venv', dir], { cwd: path.dirname(dir) });
  });
};
