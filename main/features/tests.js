// Test runner backend: pytest with a JSON-lines reporting plugin, or a unittest runner that writes the same events.
// The renderer polls the report file, so events never race the proc:exit message.
const fs = require('fs');
const os = require('os');
const path = require('path');
const { execFile } = require('child_process');
const { withPath } = require('./run.js');
const remote = require('../remote');

exports.register = (ctx) => {
  const { ipcMain, startProcess, unpackedDir } = ctx;
  const helpers = path.join(unpackedDir, 'renderer', 'features', 'tests');
  const reports = new Map(); // id -> {file, offset, rest}
  const pytestCache = new Map();

  ipcMain.handle('tests:hasPytest', (_e, interp, fresh) => {
    if (!fresh && pytestCache.has(interp.executable)) return pytestCache.get(interp.executable);
    const p = remote.isRemote(interp)
      ? remote.execPython(interp, ['-c', 'import pytest; print(pytest.__version__)'], { timeout: 60000 }).then((r) => (r.code === 0 ? r.stdout.trim() : null))
      : new Promise((resolve) => {
        execFile(interp.cmd, [...interp.args, '-c', 'import pytest; print(pytest.__version__)'], { timeout: 15000, windowsHide: true },
          (err, stdout) => resolve(err ? null : stdout.trim()));
      });
    pytestCache.set(interp.executable, p);
    return p;
  });

  // opts: {runner: 'pytest'|'unittest', targets: string[], args: string[], cwd, root, env}
  ipcMain.handle('tests:start', async (_e, interp, { runner, targets = [], args = [], cwd, root, env = {} }) => {
    const file = path.join(fs.mkdtempSync(path.join(os.tmpdir(), 'pyide-tests-')), 'report.jsonl');
    fs.writeFileSync(file, '');
    const runEnv = withPath({ ...env, PYIDE_TEST_REPORT: file }, [helpers, root]);
    const pyArgs = runner === 'pytest'
      ? ['-m', 'pytest', '-p', 'pyide_pytest_plugin', ...args, ...targets]
      : ['-u', path.join(helpers, 'pyide_unittest_runner.py'), root, ...targets];
    const opts = { cwd: cwd || root, env: runEnv };
    const id = await (remote.isRemote(interp) ? remote.startPython(ctx, interp, pyArgs, opts) : startProcess(interp.cmd, [...interp.args, ...pyArgs], opts));
    reports.set(id, { file, offset: 0 });
    return { id, command: [interp.cmd, ...interp.args, ...pyArgs].join(' ') };
  });

  // Returns events appended since the last poll; `final` releases the report.
  ipcMain.handle('tests:poll', (_e, id, final) => {
    const r = reports.get(id);
    if (!r) return [];
    let chunk = '';
    try {
      const buf = fs.readFileSync(r.file);
      // Consume whole lines only, so a write in progress never splits a UTF-8 sequence.
      const end = buf.lastIndexOf(0x0a) + 1;
      if (end > r.offset) {
        chunk = buf.subarray(r.offset, end).toString('utf8');
        r.offset = end;
      }
    } catch {}
    const lines = chunk.split('\n');
    lines.pop();
    const events = [];
    for (const line of lines) {
      try { events.push(JSON.parse(line)); } catch {}
    }
    if (final) {
      reports.delete(id);
      fs.rm(path.dirname(r.file), { recursive: true, force: true }, () => {});
    }
    return events;
  });
};
